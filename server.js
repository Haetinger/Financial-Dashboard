/*
 * Kursstand — Backend
 * Liefert das Dashboard (finanz-dashboard.html) aus und stellt unter
 * /api/indices echte Indexstände bereit (Quelle: Yahoo Finance Chart-API).
 * Keine Abhängigkeiten — braucht nur Node 18+.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const CACHE_SEK = 120; // Yahoo nicht öfter als alle 2 Minuten fragen

// ---------- Passwortschutz (HTTP Basic Auth) ----------
// Wird über Umgebungsvariablen gesetzt (siehe docker-compose.yml / .env).
// Ist KEIN Passwort gesetzt, läuft der Server offen — praktisch für lokale Tests.
const AUTH_NUTZER   = process.env.KURSSTAND_NUTZER || "axel";
const AUTH_PASSWORT = process.env.KURSSTAND_PASSWORT || "";

function zeitkonstantGleich(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authOk(req) {
  if (!AUTH_PASSWORT) return true; // kein Passwort konfiguriert -> offen
  const kopf = req.headers.authorization || "";
  if (!kopf.startsWith("Basic ")) return false;
  let nutzer = "", passwort = "";
  try {
    const [n, ...p] = Buffer.from(kopf.slice(6), "base64").toString("utf8").split(":");
    nutzer = n; passwort = p.join(":");
  } catch (e) { return false; }
  return zeitkonstantGleich(nutzer, AUTH_NUTZER) & zeitkonstantGleich(passwort, AUTH_PASSWORT) ? true : false;
}

// Wichtigste Indizes weltweit (Yahoo-Symbole)
const INDIZES = [
  "^GSPC", "^IXIC", "^GSPTSE", "^MXX", "^BVSP",              // Amerika
  "^FTSE", "^AEX", "^GDAXI", "^FCHI", "^SSMI",               // Europa Nord/West
  "FTSEMIB.MI", "^IBEX",                                     // Europa Süd
  "^N225", "^KS11", "000001.SS", "^TWII", "^HSI",            // Ostasien
  "^BSESN", "^STI", "^AXJO"                                  // Indien, Singapur, Australien
];

let cache = { zeit: 0, daten: null };

// ---------- Kurs-Cache für Einzelaktien + Wechselkurse ----------
const kursCache = new Map();   // symbol -> { zeit, daten }
const fxCache   = new Map();   // "USD" -> { zeit, rate }  (Einheiten Fremdwährung pro 1 EUR)
const KURS_CACHE_SEK = 60;
const FX_CACHE_SEK   = 600;

async function chartMeta(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
              encodeURIComponent(symbol) + "?range=1d&interval=5m";
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Kursstand-Dashboard" },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(symbol + ": HTTP " + r.status);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(symbol + ": keine Daten");
  return meta;
}

// Wechselkurs: wie viele Einheiten der Währung entsprechen 1 EUR
async function fxRate(waehrung) {
  if (waehrung === "EUR") return 1;
  const c = fxCache.get(waehrung);
  if (c && Date.now() - c.zeit < FX_CACHE_SEK * 1000) return c.rate;
  const meta = await chartMeta("EUR" + waehrung + "=X");
  const rate = meta.regularMarketPrice;
  fxCache.set(waehrung, { zeit: Date.now(), rate });
  return rate;
}

async function aktieAbfragen(symbol) {
  const c = kursCache.get(symbol);
  if (c && Date.now() - c.zeit < KURS_CACHE_SEK * 1000) return c.daten;

  const meta = await chartMeta(symbol);
  let kurs = meta.regularMarketPrice;
  let hoch = meta.regularMarketDayHigh ?? null;
  let tief = meta.regularMarketDayLow ?? null;
  let vortag = meta.chartPreviousClose ?? meta.previousClose ?? null;
  let waehrung = meta.currency || "USD";

  // Londoner Kurse kommen in Pence (GBp) — erst in GBP wandeln
  if (waehrung === "GBp" || waehrung === "GBX") {
    kurs /= 100; if (hoch) hoch /= 100; if (tief) tief /= 100; if (vortag) vortag /= 100;
    waehrung = "GBP";
  }

  const rate = await fxRate(waehrung); // Einheiten Währung pro 1 EUR
  const inEur = x => (x == null ? null : x / rate);
  const diff = vortag != null ? kurs - vortag : null;

  const daten = {
    symbol,
    waehrung,
    kurs,
    diffPzt: diff != null && vortag ? (diff / vortag) * 100 : null,
    kursEur: inEur(kurs),
    diffEur: inEur(diff),
    hochEur: inEur(hoch),
    tiefEur: inEur(tief)
  };
  kursCache.set(symbol, { zeit: Date.now(), daten });
  return daten;
}

async function indexAbfragen(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
              encodeURIComponent(symbol) + "?range=1d&interval=5m";
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Kursstand-Dashboard" },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(symbol + ": HTTP " + r.status);
  const j = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(symbol + ": keine Daten");
  const kurs = meta.regularMarketPrice;
  const schluss = meta.chartPreviousClose ?? meta.previousClose;
  const diff = schluss ? kurs - schluss : null;
  return {
    symbol,
    kurs,
    vortag: schluss ?? null,
    diff,
    diffPzt: diff != null && schluss ? (diff / schluss) * 100 : null,
    waehrung: meta.currency || "",
    zeit: meta.regularMarketTime || null
  };
}

async function alleIndizes() {
  const jetzt = Date.now();
  if (cache.daten && jetzt - cache.zeit < CACHE_SEK * 1000) return cache.daten;
  const ergebnisse = await Promise.allSettled(INDIZES.map(indexAbfragen));
  const daten = ergebnisse.map((e, i) =>
    e.status === "fulfilled" ? e.value : { symbol: INDIZES[i], fehler: true }
  );
  // Nur cachen, wenn mindestens ein Index geliefert wurde
  if (daten.some(d => !d.fehler)) cache = { zeit: jetzt, daten };
  return daten;
}

// ---------- Symbolsuche (Firmenname -> Ticker) ----------
const sucheCache = new Map(); // q -> { zeit, daten }
const SUCHE_CACHE_SEK = 3600;

async function symbolSuche(q) {
  const key = q.toLowerCase();
  const c = sucheCache.get(key);
  if (c && Date.now() - c.zeit < SUCHE_CACHE_SEK * 1000) return c.daten;
  const url = "https://query1.finance.yahoo.com/v1/finance/search?q=" +
              encodeURIComponent(q) + "&quotesCount=8&newsCount=0&listsCount=0";
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Kursstand-Dashboard" },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error("Suche: HTTP " + r.status);
  const j = await r.json();
  const daten = (j.quotes || [])
    .filter(t => t.quoteType === "EQUITY" || t.quoteType === "ETF")
    .map(t => ({
      symbol: t.symbol,
      name: t.shortname || t.longname || t.symbol,
      boerse: t.exchDisp || "",
      typ: t.typeDisp || ""
    }));
  sucheCache.set(key, { zeit: Date.now(), daten });
  return daten;
}

// ---------- Kurshistorie (Tagesdaten von Yahoo, in EUR umgerechnet) ----------
const histCache = new Map(); // "symbol|range" -> { zeit, daten }
const HIST_CACHE_SEK = 3600;
const HIST_RANGES = { "1mo": "1d", "6mo": "1d", "1y": "1d", "5y": "1wk" };

async function historieAbfragen(symbol, range, roh) {
  const key = symbol + "|" + range + (roh ? "|roh" : "");
  const c = histCache.get(key);
  if (c && Date.now() - c.zeit < HIST_CACHE_SEK * 1000) return c.daten;
  const interval = HIST_RANGES[range] || "1d";
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
              encodeURIComponent(symbol) + "?range=" + range + "&interval=" + interval;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Kursstand-Dashboard" },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(symbol + ": HTTP " + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res || !res.timestamp) throw new Error(symbol + ": keine Historie");
  let waehrung = res.meta.currency || "USD";
  let pence = false;
  if (waehrung === "GBp" || waehrung === "GBX") { waehrung = "GBP"; pence = true; }
  const rate = roh ? 1 : await fxRate(waehrung);
  const close = res.indicators?.quote?.[0]?.close || [];
  const punkte = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (close[i] == null) continue;
    const wert = (pence ? close[i] / 100 : close[i]) / rate;
    punkte.push([res.timestamp[i] * 1000, +wert.toFixed(4)]);
  }
  const daten = { symbol, punkte };
  histCache.set(key, { zeit: Date.now(), daten });
  return daten;
}

// ---------- Rohstoffe & Krypto ----------
let maerkteCache = { zeit: 0, daten: null };
async function maerkteAbfragen() {
  if (maerkteCache.daten && Date.now() - maerkteCache.zeit < 120000) return maerkteCache.daten;
  const [gold, oel, wti, kupfer, btc] = await Promise.allSettled([
    aktieAbfragen("GC=F"), aktieAbfragen("BZ=F"), aktieAbfragen("CL=F"), aktieAbfragen("HG=F"), aktieAbfragen("BTC-EUR")
  ]);
  let eurusd = null;
  try {
    const m = await chartMeta("EURUSD=X");
    const vortag = m.chartPreviousClose ?? m.previousClose;
    eurusd = { kurs: m.regularMarketPrice, diffPzt: vortag ? (m.regularMarketPrice - vortag) / vortag * 100 : null };
  } catch (e) { /* still */ }
  const eintrag = (name, e, symbol) =>
    e.status === "fulfilled"
      ? { name, symbol, kursEur: e.value.kursEur, diffPzt: e.value.diffPzt, einheit: "€" }
      : { name, symbol, fehler: true };
  const daten = [
    eintrag("Gold (Unze)", gold, "GC=F"),
    eintrag("Öl Brent (Barrel)", oel, "BZ=F"),
    eintrag("Öl WTI (Barrel)", wti, "CL=F"),
    eintrag("Kupfer (Pfund)", kupfer, "HG=F"),
    eintrag("Bitcoin", btc, "BTC-EUR"),
    eurusd ? { name: "EUR/USD", symbol: "EURUSD=X", kursEur: eurusd.kurs, diffPzt: eurusd.diffPzt, einheit: "$" }
           : { name: "EUR/USD", symbol: "EURUSD=X", fehler: true }
  ];
  if (daten.some(d => !d.fehler)) maerkteCache = { zeit: Date.now(), daten };
  return daten;
}

// ---------- Kurs-Alarme (persistent, Benachrichtigung via ntfy) ----------
const NTFY_URL = process.env.NTFY_URL || "";
const DATEN_ORDNER = path.join(__dirname, "daten");
const ALARM_DATEI = path.join(DATEN_ORDNER, "alarme.json");
try { fs.mkdirSync(DATEN_ORDNER, { recursive: true }); } catch (e) {}

function alarmeLaden() {
  try { return JSON.parse(fs.readFileSync(ALARM_DATEI, "utf8")); } catch (e) { return []; }
}
function alarmeSpeichern(liste) {
  try { fs.writeFileSync(ALARM_DATEI, JSON.stringify(liste)); } catch (e) { console.error("Alarme speichern fehlgeschlagen:", e.message); }
}

async function alarmePruefen() {
  const alarme = alarmeLaden();
  if (!alarme.length || !NTFY_URL) return;
  const uebrig = [];
  for (const a of alarme) {
    let ausgeloest = false;
    try {
      const q = await aktieAbfragen(a.symbol);
      if (a.richtung === "unter" && q.kursEur <= a.schwelle) ausgeloest = true;
      if (a.richtung === "ueber" && q.kursEur >= a.schwelle) ausgeloest = true;
      if (ausgeloest) {
        await fetch(NTFY_URL, {
          method: "POST",
          headers: {
            "Title": "Kursstand: " + a.symbol,
            "Priority": "high",
            "Tags": a.richtung === "unter" ? "chart_with_downwards_trend" : "chart_with_upwards_trend"
          },
          body: a.symbol + " ist " + (a.richtung === "unter" ? "unter" : "über") + " " +
                a.schwelle.toFixed(2) + " € (aktuell " + q.kursEur.toFixed(2) + " €)",
          signal: AbortSignal.timeout(8000)
        });
        console.log("Alarm ausgelöst: " + a.symbol + " " + a.richtung + " " + a.schwelle);
      }
    } catch (e) { /* Symbol gerade nicht abfragbar -> Alarm behalten */ }
    if (!ausgeloest) uebrig.push(a);
  }
  if (uebrig.length !== alarme.length) alarmeSpeichern(uebrig);
}
setInterval(alarmePruefen, 5 * 60 * 1000);

function bodyLesen(req) {
  return new Promise((aufloesen, ablehnen) => {
    let daten = "";
    req.on("data", t => { daten += t; if (daten.length > 10000) { ablehnen(new Error("zu groß")); req.destroy(); } });
    req.on("end", () => aufloesen(daten));
    req.on("error", ablehnen);
  });
}

// ---------- PWA: Manifest & Service Worker ----------
const PWA_ICON = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0C111B"/><text x="256" y="330" font-family="sans-serif" font-size="260" font-weight="bold" text-anchor="middle" fill="#F0B429">K</text></svg>'
);
const MANIFEST = JSON.stringify({
  name: "Kursstand", short_name: "Kursstand", start_url: "/", display: "standalone",
  background_color: "#0C111B", theme_color: "#0C111B",
  icons: [{ src: PWA_ICON, sizes: "any", type: "image/svg+xml", purpose: "any" }]
});
const SERVICE_WORKER = [
  "const CACHE='kursstand-v2';",
  "self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.add('/')));});",
  "self.addEventListener('activate',e=>self.clients.claim());",
  "self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;",
  "e.respondWith(fetch(e.request).catch(()=>caches.match('/')));});"
].join("\n");

// ---------- Wirtschaftsnachrichten (RSS) ----------
const STANDARD_FEEDS = [
  "https://www.tagesschau.de/wirtschaft/index~rss2.xml",             // deutsch
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",          // CNBC Top News
  "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",    // Wall Street Journal Markets
  "https://feeds.content.dowjones.io/public/rss/mw_topstories",     // MarketWatch
  "https://www.ft.com/rss/home",                                    // Financial Times
  "https://feeds.bbci.co.uk/news/business/rss.xml",                 // BBC Business
  "https://www.theguardian.com/uk/business/rss",                    // Guardian Business
  "https://finance.yahoo.com/news/rssindex"                         // Yahoo Finance
].join(",");
const NEWS_FEEDS = (process.env.NEWS_FEEDS || STANDARD_FEEDS)
  .split(",").map(s => s.trim()).filter(Boolean);
let newsCache = { zeit: 0, daten: null };

function xmlEntitäten(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").trim();
}

async function newsAbfragen() {
  if (newsCache.daten && Date.now() - newsCache.zeit < 600000) return newsCache.daten;
  const proFeed = [];   // [{ quelle, ok, eintraege }]
  await Promise.allSettled(NEWS_FEEDS.map(async feed => {
    let quelle = feed;
    try { quelle = new URL(feed).hostname.replace(/^www\.|^feeds\./, ""); } catch (e) {}
    const status = { quelle, ok: false, eintraege: [] };
    proFeed.push(status);
    try {
      const r = await fetch(feed, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Kursstand-Dashboard RSS-Reader" },
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const xml = await r.text();
      for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
        const titel = block.match(/<title>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/title>/);
        const link = block.match(/<link>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/link>/);
        const datum = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        if (!titel) continue;
        status.eintraege.push({
          titel: xmlEntitäten(titel[1]),
          link: link ? xmlEntitäten(link[1]) : "",
          zeit: datum ? Date.parse(datum[1]) || 0 : 0,
          quelle
        });
      }
      status.eintraege.sort((a, b) => b.zeit - a.zeit);
      status.eintraege = status.eintraege.slice(0, 8); // keine Quelle dominiert
      status.ok = status.eintraege.length > 0;
    } catch (e) { status.fehler = String(e.message || e); }
  }));
  if (!proFeed.some(f => f.ok)) throw new Error("kein Feed erreichbar");
  // Round-Robin: reihum die jeweils neueste Meldung jeder Quelle -> garantierte Vielfalt
  const alle = [];
  for (let i = 0; i < 8; i++) {
    for (const f of proFeed) if (f.eintraege[i]) alle.push(f.eintraege[i]);
  }
  const daten = alle.slice(0, 40);
  newsCache = { zeit: Date.now(), daten, status: proFeed.map(f => ({ quelle: f.quelle, ok: f.ok, anzahl: f.eintraege.length, fehler: f.fehler })) };
  return daten;
}


// ---------- Marktlage (Regionen, Faktoren, Risiko) ----------
const rohCache = new Map(); // symbol -> { zeit, meta }
async function rohMeta(symbol) {
  const c = rohCache.get(symbol);
  if (c && Date.now() - c.zeit < 120000) return c.meta;
  const meta = await chartMeta(symbol);
  rohCache.set(symbol, { zeit: Date.now(), meta });
  return meta;
}
function metaWert(m, faktor) {
  const kurs = m.regularMarketPrice * (faktor || 1);
  const vortag = (m.chartPreviousClose ?? m.previousClose ?? null);
  const diffPzt = vortag ? (m.regularMarketPrice - vortag) / vortag * 100 : null;
  return { kurs, diffPzt };
}
let lageCache = { zeit: 0, daten: null };
async function marktlageAbfragen() {
  if (lageCache.daten && Date.now() - lageCache.zeit < 120000) return lageCache.daten;
  const einzel = [
    { name: "STOXX Europe 600", symbol: "^STOXX", gruppe: "regionen", einheit: "Pkt.", idx: true },
    { name: "Welt (ACWI-ETF)", symbol: "ACWI", gruppe: "regionen", einheit: "$", chart: true },
    { name: "Emerging Markets (EEM)", symbol: "EEM", gruppe: "regionen", einheit: "$", chart: true },
    { name: "CSI 300 (China)", symbol: "000300.SS", gruppe: "regionen", einheit: "Pkt.", idx: true },
    { name: "VIX (Volatilität)", symbol: "^VIX", gruppe: "risiko", einheit: "Pkt.", idx: true },
    { name: "US-Zins 10 Jahre", symbol: "^TNX", gruppe: "risiko", einheit: "%", faktor: 0.1 },
    { name: "Dollar-Index", symbol: "DX-Y.NYB", gruppe: "risiko", einheit: "Pkt.", idx: true }
  ];
  const ratios = [
    { name: "Marktbreite (Equal-Weight ÷ S&P)", a: "RSP", b: "SPY", gruppe: "faktoren" },
    { name: "Growth ÷ Value", a: "VUG", b: "VTV", gruppe: "faktoren" },
    { name: "Small ÷ Large Caps", a: "IWM", b: "SPY", gruppe: "faktoren" }
  ];
  const symbole = [...new Set([...einzel.map(e => e.symbol), ...ratios.flatMap(r => [r.a, r.b])])];
  const metas = new Map();
  await Promise.allSettled(symbole.map(async sym => { metas.set(sym, await rohMeta(sym)); }));
  const daten = [];
  for (const e of einzel) {
    const m = metas.get(e.symbol);
    if (!m) { daten.push({ name: e.name, gruppe: e.gruppe, fehler: true }); continue; }
    const w = metaWert(m, e.faktor);
    daten.push({ name: e.name, gruppe: e.gruppe, kurs: w.kurs, diffPzt: w.diffPzt, einheit: e.einheit,
                 symbol: e.symbol, idx: !!e.idx, chart: !!e.chart });
  }
  for (const r of ratios) {
    const ma = metas.get(r.a), mb = metas.get(r.b);
    if (!ma || !mb) { daten.push({ name: r.name, gruppe: r.gruppe, fehler: true }); continue; }
    const wa = metaWert(ma), wb = metaWert(mb);
    daten.push({ name: r.name, gruppe: r.gruppe, kurs: wa.kurs / wb.kurs,
                 diffPzt: (wa.diffPzt != null && wb.diffPzt != null) ? wa.diffPzt - wb.diffPzt : null,
                 einheit: "", ratio: true });
  }
  if (daten.some(d => !d.fehler)) lageCache = { zeit: Date.now(), daten };
  return daten;
}

// ---------- Marktbewegungen (Gewinner/Verlierer/Volatilität/52W) ----------
// Festes Universum: S&P-100-Kern + DAX. Kein Gesamtmarkt-Screener, dafür robust.
const UNIVERSUM = [
  // USA (S&P-100-Kern)
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","BRK-B","AVGO","JPM",
  "LLY","V","UNH","XOM","MA","COST","HD","PG","JNJ","NFLX",
  "ABBV","BAC","CRM","CVX","KO","AMD","PEP","TMO","WMT","MCD",
  "CSCO","ACN","ADBE","LIN","ORCL","ABT","WFC","IBM","GE","TXN",
  "QCOM","CAT","DIS","VZ","INTU","AMGN","PFE","PM","NEE","ISRG",
  "NOW","GS","SPGI","UBER","RTX","HON","UNP","AMAT","BLK","T",
  "LOW","BKNG","COP","MS","SYK","ELV","SCHW","LMT","VRTX","ADI",
  "C","DE","PLD","MDT","CB","REGN","BSX","PANW","MMC","SBUX",
  "GILD","ADP","MU","LRCX","BA","MO","TJX","CI","INTC","NKE",
  "PYPL","CMCSA","EMR","SO","DUK",
  // Deutschland (DAX-Kern)
  "SAP.DE","SIE.DE","ALV.DE","DTE.DE","AIR.DE","MUV2.DE","MBG.DE","BMW.DE",
  "BAS.DE","BAYN.DE","IFX.DE","DBK.DE","DB1.DE","ADS.DE","EOAN.DE","RWE.DE",
  "DHL.DE","HEN3.DE","VOW3.DE","MRK.DE","SHL.DE","ZAL.DE","FRE.DE","CON.DE",
  "HEI.DE","MTX.DE","RHM.DE","VNA.DE","PUM.DE","BEI.DE"
];
let moverCache = { zeit: 0, daten: null };
let moverLaeuft = null;

async function moverBerechnen() {
  const werte = [];
  const stapelGroesse = 15; // schonend in Stapeln abfragen
  for (let i = 0; i < UNIVERSUM.length; i += stapelGroesse) {
    const stapel = UNIVERSUM.slice(i, i + stapelGroesse);
    const ergebnisse = await Promise.allSettled(stapel.map(chartMeta));
    ergebnisse.forEach((e, j) => {
      if (e.status !== "fulfilled") return;
      const m = e.value;
      const kurs = m.regularMarketPrice;
      const vortag = m.chartPreviousClose ?? m.previousClose;
      const hoch = m.regularMarketDayHigh, tief = m.regularMarketDayLow;
      if (!kurs || !vortag) return;
      werte.push({
        symbol: stapel[j],
        diffPzt: (kurs - vortag) / vortag * 100,
        volPzt: (hoch != null && tief != null) ? (hoch - tief) / vortag * 100 : null,
        w52hAbstand: m.fiftyTwoWeekHigh ? (kurs / m.fiftyTwoWeekHigh - 1) * 100 : null,
        w52tAbstand: m.fiftyTwoWeekLow ? (kurs / m.fiftyTwoWeekLow - 1) * 100 : null
      });
    });
  }
  if (!werte.length) throw new Error("keine Universum-Daten");
  const top = (feld, richtung, filter) => werte
    .filter(w => w[feld] != null && (!filter || filter(w)))
    .sort((a, b) => richtung * (b[feld] - a[feld]))
    .slice(0, 6)
    .map(w => ({ symbol: w.symbol, diffPzt: +w.diffPzt.toFixed(2),
                 wert: +w[feld].toFixed(2) }));
  return {
    stand: Date.now(),
    gewinner: top("diffPzt", 1),
    verlierer: top("diffPzt", -1),
    volatil: top("volPzt", 1),
    hochs: top("w52hAbstand", 1, w => w.w52hAbstand >= -0.5),   // max. 0,5 % unterm 52W-Hoch
    tiefs: top("w52tAbstand", -1, w => w.w52tAbstand <= 0.5)    // max. 0,5 % überm 52W-Tief
  };
}

async function moversAbfragen() {
  if (moverCache.daten && Date.now() - moverCache.zeit < 600000) return moverCache.daten;
  if (!moverLaeuft) {
    moverLaeuft = moverBerechnen()
      .then(d => { moverCache = { zeit: Date.now(), daten: d }; return d; })
      .finally(() => { moverLaeuft = null; });
  }
  return moverLaeuft;
}

const server = http.createServer(async (req, res) => {
  if (!authOk(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Kursstand", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("Anmeldung erforderlich");
    return;
  }

  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/api/suche") {
    const q = (u.searchParams.get("q") || "").trim();
    if (q.length < 2) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
      return;
    }
    try {
      const daten = await symbolSuche(q);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600"
      });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === "/api/indices") {
    try {
      const daten = await alleIndizes();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60"
      });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === "/api/quotes") {
    const symbole = (u.searchParams.get("symbols") || "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 50);
    if (!symbole.length) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: "symbols-Parameter fehlt" }));
      return;
    }
    const ergebnisse = await Promise.allSettled(symbole.map(aktieAbfragen));
    const daten = ergebnisse.map((e, i) =>
      e.status === "fulfilled" ? e.value : { symbol: symbole[i], fehler: true }
    );
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30"
    });
    res.end(JSON.stringify(daten));
    return;
  }

  if (u.pathname === "/api/historie") {
    const symbol = (u.searchParams.get("symbol") || "").trim().toUpperCase();
    const range = HIST_RANGES[u.searchParams.get("range")] ? u.searchParams.get("range") : "6mo";
    if (!symbol) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: "symbol-Parameter fehlt" }));
      return;
    }
    try {
      const daten = await historieAbfragen(symbol, range, u.searchParams.get("roh") === "1");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=1800" });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === "/api/maerkte") {
    try {
      const daten = await maerkteAbfragen();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === "/api/alarme") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ntfy: !!NTFY_URL, alarme: alarmeLaden() }));
      return;
    }
    if (req.method === "POST") {
      try {
        const b = JSON.parse(await bodyLesen(req));
        const symbol = String(b.symbol || "").trim().toUpperCase();
        const richtung = b.richtung === "ueber" ? "ueber" : "unter";
        const schwelle = parseFloat(b.schwelle);
        if (!symbol || !(schwelle > 0)) throw new Error("symbol/schwelle ungültig");
        const alarme = alarmeLaden();
        if (alarme.length >= 50) throw new Error("zu viele Alarme");
        alarme.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), symbol, richtung, schwelle });
        alarmeSpeichern(alarme);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ fehler: String(e.message || e) }));
      }
      return;
    }
    if (req.method === "DELETE") {
      const id = u.searchParams.get("id") || "";
      alarmeSpeichern(alarmeLaden().filter(a => a.id !== id));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(405); res.end();
    return;
  }

  if (u.pathname === "/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
    res.end(MANIFEST);
    return;
  }
  if (u.pathname === "/sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    res.end(SERVICE_WORKER);
    return;
  }

  if (u.pathname === "/api/news") {
    try {
      const daten = await newsAbfragen();
      if (u.searchParams.get("status") === "1") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(newsCache.status || [], null, 1));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === "/api/marktlage") {
    try {
      const daten = await marktlageAbfragen();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  if (u.pathname === "/api/movers") {
    try {
      const daten = await moversAbfragen();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(JSON.stringify(daten));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fehler: String(e.message || e) }));
    }
    return;
  }

  // Statisch: Dashboard ausliefern
  if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/finanz-dashboard.html") {
    const datei = path.join(__dirname, "finanz-dashboard.html");
    fs.readFile(datei, (err, inhalt) => {
      if (err) { res.writeHead(404); res.end("finanz-dashboard.html nicht gefunden"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(inhalt);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Nicht gefunden");
});

server.listen(PORT, () => {
  console.log("Kursstand-Backend läuft auf Port " + PORT +
    (AUTH_PASSWORT ? " · Passwortschutz aktiv (Nutzer: " + AUTH_NUTZER + ")" : " · OHNE Passwortschutz (KURSSTAND_PASSWORT nicht gesetzt)") + (NTFY_URL ? " · Alarme via ntfy aktiv" : " · Alarme ohne ntfy (NTFY_URL nicht gesetzt)"));
});
