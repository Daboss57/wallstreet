const express = require('express');
const http = require('http');
const path = require('path');

// Init database first
require('./src/db');

const apiRouter = require('./src/api');
const engine = require('./src/engine');
const news = require('./src/news');
const wsServer = require('./src/wsServer');
const firmsRouter = require('./src/firms');

const app = express();
const server = http.createServer(app);

// ─── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS for development
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ─── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRouter);
app.use('/api/firms', firmsRouter);

// ─── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Initialize WebSocket ──────────────────────────────────────────────────────
wsServer.init(server);

// ─── Start Everything ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

engine.start();
news.start();

server.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════════════╗
  ║                                               ║
  ║   ███████╗████████╗██████╗ ███████╗███████╗   ║
  ║   ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██╔════╝   ║
  ║   ███████╗   ██║   ██████╔╝█████╗  █████╗     ║
  ║   ╚════██║   ██║   ██╔══██╗██╔══╝  ██╔══╝     ║
  ║   ███████║   ██║   ██║  ██║███████╗███████╗   ║
  ║   ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚══════╝   ║
  ║                 StreetOS v2.0                  ║
  ║          Wall Street Simulator                 ║
  ║                                               ║
  ║   Server:    http://localhost:${PORT}             ║
  ║   WebSocket: ws://localhost:${PORT}/ws             ║
  ║   Tickers:   ${engine.TICKER_LIST.length} instruments                    ║
  ║   Tick Rate:  1 second                         ║
  ║                                               ║
  ╚═══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    engine.stop();
    news.stop();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    engine.stop();
    news.stop();
    server.close();
    process.exit(0);
});
