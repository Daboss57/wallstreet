const WebSocket = require('ws');
const { verifyToken } = require('./auth');
const engine = require('./engine');
const orderbook = require('./orderbook');
const matcher = require('./matcher');
const { stmts } = require('./db');

// ─── WebSocket Server ──────────────────────────────────────────────────────────
// Ultra low latency: direct message buffering, per-ticker subscription, binary-ready

const clients = new Map(); // ws → { userId, username, subscriptions: Set<ticker>, authenticated }

function init(server) {
    const wss = new WebSocket.Server({ server, path: '/ws' });

    wss.on('connection', (ws, req) => {
        const clientState = {
            userId: null,
            username: null,
            subscriptions: new Set(),
            authenticated: false
        };
        clients.set(ws, clientState);

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                handleMessage(ws, clientState, msg);
            } catch (e) {
                sendJSON(ws, { type: 'error', message: 'Invalid JSON' });
            }
        });

        ws.on('close', () => {
            clients.delete(ws);
        });

        ws.on('error', () => {
            clients.delete(ws);
        });

        // Send initial state once authenticated
        sendJSON(ws, { type: 'connected', message: 'Connected to StreetOS' });
    });

    // Heartbeat — kill dead connections
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) { ws.terminate(); clients.delete(ws); return; }
            ws.isAlive = false;
            ws.ping();
        });
    }, 15000);

    wss.on('close', () => clearInterval(heartbeat));

    // ── Hook into engine for tick broadcasts ──
    engine.setTickCallback((tickData) => {
        // Batch all ticks into one message per client for ultra low latency
        const bySubscriber = new Map();

        for (const tick of tickData) {
            for (const [ws, state] of clients) {
                if (ws.readyState !== WebSocket.OPEN) continue;
                if (!state.authenticated) continue;

                // Send if subscribed to this ticker OR subscribed to 'all'
                if (state.subscriptions.has(tick.ticker) || state.subscriptions.has('all')) {
                    if (!bySubscriber.has(ws)) bySubscriber.set(ws, []);
                    bySubscriber.get(ws).push(tick);
                }
            }
        }

        // Send batched ticks
        for (const [ws, ticks] of bySubscriber) {
            sendJSON(ws, { type: 'ticks', data: ticks });
        }

        // Run order matching every tick
        matcher.matchAll();

        // Send order book updates every 2nd tick for subscribed tickers
        if (engine.TICKER_LIST._tickBookCounter === undefined) engine.TICKER_LIST._tickBookCounter = 0;
        engine.TICKER_LIST._tickBookCounter++;
        if (engine.TICKER_LIST._tickBookCounter % 2 === 0) {
            broadcastOrderBooks();
        }
    });

    // ── Hook into engine for news broadcasts ──
    engine.setNewsCallback((event) => {
        broadcast({ type: 'news', data: event });
    });

    // ── Hook into matcher for fill broadcasts ──
    matcher.setFillCallback((userId, fill) => {
        for (const [ws, state] of clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (state.userId === userId) {
                sendJSON(ws, fill);
                // Also send updated positions and cash
                sendPortfolioUpdate(ws, userId);
            }
        }
    });

    console.log('[WebSocket] Server initialized');
    return wss;
}

function handleMessage(ws, state, msg) {
    switch (msg.type) {
        case 'auth': {
            const decoded = verifyToken(msg.token);
            if (!decoded) {
                sendJSON(ws, { type: 'auth_error', message: 'Invalid token' });
                return;
            }
            state.userId = decoded.id;
            state.username = decoded.username;
            state.authenticated = true;
            // Subscribe to all tickers by default
            state.subscriptions.add('all');
            sendJSON(ws, { type: 'authenticated', username: decoded.username });

            // Send initial portfolio state
            sendPortfolioUpdate(ws, decoded.id);
            break;
        }
        case 'subscribe': {
            if (!state.authenticated) return;
            if (msg.tickers) {
                state.subscriptions.clear();
                for (const t of msg.tickers) {
                    state.subscriptions.add(t.toUpperCase());
                }
            }
            break;
        }
        case 'subscribe_all': {
            if (!state.authenticated) return;
            state.subscriptions.clear();
            state.subscriptions.add('all');
            break;
        }
        case 'unsubscribe': {
            if (!state.authenticated) return;
            if (msg.ticker) state.subscriptions.delete(msg.ticker.toUpperCase());
            break;
        }
        case 'ping': {
            sendJSON(ws, { type: 'pong', timestamp: Date.now() });
            break;
        }
    }
}

function sendPortfolioUpdate(ws, userId) {
    const user = stmts.getUserById.get(userId);
    if (!user) return;

    const positions = stmts.getUserPositions.all(userId);
    const enriched = positions.map(p => {
        const priceData = engine.getPrice(p.ticker);
        const currentPrice = priceData?.price || p.avg_cost;
        const marketValue = p.qty * currentPrice;
        const unrealizedPnl = marketValue - p.qty * p.avg_cost;
        return {
            ...p, currentPrice, marketValue: +marketValue.toFixed(2),
            unrealizedPnl: +unrealizedPnl.toFixed(2),
            pnlPct: p.avg_cost ? +(((currentPrice - p.avg_cost) / p.avg_cost) * 100).toFixed(2) : 0
        };
    });

    const openOrders = stmts.getOpenOrders.all(userId);

    sendJSON(ws, {
        type: 'portfolio',
        cash: user.cash,
        positions: enriched,
        openOrders
    });
}

function broadcastOrderBooks() {
    // Collect unique subscribed tickers
    const tickers = new Set();
    for (const [ws, state] of clients) {
        if (ws.readyState !== WebSocket.OPEN || !state.authenticated) continue;
        if (state.subscriptions.has('all')) {
            // Only send top-5 most popular tickers
            engine.TICKER_LIST.slice(0, 10).forEach(t => tickers.add(t));
        } else {
            state.subscriptions.forEach(t => tickers.add(t));
        }
    }

    for (const ticker of tickers) {
        const userOrders = stmts.getOpenOrdersByTicker.all(ticker);
        const book = orderbook.generateBook(ticker, userOrders);

        for (const [ws, state] of clients) {
            if (ws.readyState !== WebSocket.OPEN || !state.authenticated) continue;
            if (state.subscriptions.has(ticker) || state.subscriptions.has('all')) {
                sendJSON(ws, { type: 'orderbook', data: book });
            }
        }
    }
}

function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const [ws, state] of clients) {
        if (ws.readyState === WebSocket.OPEN && state.authenticated) {
            ws.send(payload);
        }
    }
}

function sendJSON(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

module.exports = { init };
