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

const PORT = process.env.PORT || 8080;
const CACHE_SEK = 120; // Yahoo nicht öfter als alle 2 Minuten fragen

// Wichtigste Indizes weltweit (Yahoo-Symbole)
const INDIZES = [
  "^GSPC", "^GSPTSE", "^BVSP",           // Amerika
  "^FTSE", "^GDAXI", "^FCHI",            // Europa
  "^N225", "^HSI", "000001.SS",          // Ostasien
  "^BSESN", "^KS11", "^AXJO"             // Indien, Korea, Australien
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

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
  console.log("Kursstand-Backend läuft auf Port " + PORT);
});
