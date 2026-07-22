FROM node:22-alpine
WORKDIR /app
COPY server.js finanz-dashboard.html ./
RUN mkdir -p /app/daten && chown node:node /app/daten
EXPOSE 8080
USER node
CMD ["node", "server.js"]
