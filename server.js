const express = require('express');
const http = require('http');
const path = require('path');

const apiRouter = require('./src/api');
const engine = require('./src/engine');
const news = require('./src/news');
const wsServer = require('./src/wsServer');
const matcher = require('./src/matcher');
const {
    initDb,
    closeDb,
    probeDb,
    getDbStatus,
    isDbHealthy,
} = require('./src/db');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DB_HEALTH_CHECK_INTERVAL_MS = Number.parseInt(process.env.DB_HEALTH_CHECK_INTERVAL_MS || '10000', 10);
const PAUSE_BACKGROUND_ON_DB_DOWN = ['1', 'true', 'yes', 'on'].includes(String(process.env.PAUSE_BACKGROUND_ON_DB_DOWN || 'true').toLowerCase());

let dbMonitorInterval = null;
let backgroundPaused = false;
let shuttingDown = false;

function pauseBackground(reason = 'db_unavailable') {
    if (!PAUSE_BACKGROUND_ON_DB_DOWN) return;
    if (backgroundPaused) return;
    backgroundPaused = true;
    engine.pause(reason);
    news.pause(reason);
    matcher.setPaused(true, reason);
    console.warn('[Server] Background loops paused while DB is unavailable');
}

function resumeBackground() {
    if (!PAUSE_BACKGROUND_ON_DB_DOWN) return;
    if (!backgroundPaused) return;
    backgroundPaused = false;
    engine.resume();
    news.resume();
    matcher.setPaused(false);
    console.log('[Server] Background loops resumed');
}

async function monitorDbHealth() {
    if (dbMonitorInterval) clearInterval(dbMonitorInterval);
    dbMonitorInterval = setInterval(async () => {
        if (shuttingDown) return;

        if (!isDbHealthy()) {
            pauseBackground('db_unavailable');
            await probeDb();
            return;
        }

        if (backgroundPaused) {
            resumeBackground();
        }
    }, DB_HEALTH_CHECK_INTERVAL_MS);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    return next();
});

app.get('/healthz', (req, res) => {
    const db = getDbStatus();
    res.json({
        status: 'ok',
        db: {
            connected: db.connected,
            mode: db.mode,
            lastErrorCode: db.lastErrorCode,
        },
        backgroundPaused,
    });
});

app.get('/readyz', (req, res) => {
    const db = getDbStatus();
    const ready = db.connected;
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        db: {
            connected: db.connected,
            mode: db.mode,
            lastErrorCode: db.lastErrorCode,
        },
    });
});

app.use('/api', apiRouter);

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

wsServer.init(server);

async function bootstrap() {
    try {
        await initDb();
    } catch (error) {
        console.error('[Server] Initial DB connection failed:', error.message);
        pauseBackground('startup_db_unavailable');
    }

    try {
        await engine.start();
    } catch (error) {
        console.error('[Server] Engine startup failed:', error.message);
    }
    news.start();

    await monitorDbHealth();

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
}

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[Server] Shutting down...');

    if (dbMonitorInterval) clearInterval(dbMonitorInterval);

    try {
        await engine.stop();
    } catch (error) {
        console.error('[Server] Engine stop failed:', error.message);
    }
    news.stop();

    try {
        await closeDb();
    } catch (error) {
        console.error('[Server] DB close failed:', error.message);
    }

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap().catch((error) => {
    console.error('[Server] Bootstrap failed:', error.message);
    process.exit(1);
});
