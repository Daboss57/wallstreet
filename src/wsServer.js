const WebSocket = require('ws');
const { verifyToken } = require('./auth');
const engine = require('./engine');
const orderbook = require('./orderbook');
const matcher = require('./matcher');
const { getAll, getOne } = require('./db');

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

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data);
                await handleMessage(ws, clientState, msg);
            } catch (e) {
                console.error('WS Message Error:', e);
                sendJSON(ws, { type: 'error', message: 'Invalid request' });
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
        // matchAll is async, we call it without await to not block tick loop, but catch errors
        matcher.matchAll().catch(e => console.error('Matcher Error:', e));

        // Send order book updates every 2nd tick for subscribed tickers
        if (engine.TICKER_LIST._tickBookCounter === undefined) engine.TICKER_LIST._tickBookCounter = 0;
        engine.TICKER_LIST._tickBookCounter++;
        if (engine.TICKER_LIST._tickBookCounter % 2 === 0) {
            broadcastOrderBooks().catch(e => console.error('Orderbook Broadcast Error:', e));
        }
    });

    // ── Hook into engine for news broadcasts ──
    engine.setNewsCallback((event) => {
        broadcast({ type: 'news', data: event });
    });

    // ── Hook into matcher for fill broadcasts ──
    matcher.setFillCallback(async (userId, fill) => {
        for (const [ws, state] of clients) {
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (state.userId === userId) {
                sendJSON(ws, fill);
                // Also send updated positions and cash
                await sendPortfolioUpdate(ws, userId);
            }
        }
    });

    console.log('[WebSocket] Server initialized');
    return wss;
}

async function handleMessage(ws, state, msg) {
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
            await sendPortfolioUpdate(ws, decoded.id);
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

async function sendPortfolioUpdate(ws, userId) {
    try {
        const user = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
        if (!user) return;

        const positions = await getAll('SELECT * FROM positions WHERE user_id = $1', [userId]);
        const enriched = positions.map(p => {
            const priceData = engine.getPrice(p.ticker);
            const currentPrice = priceData?.price || p.avg_cost;
            const marketValue = p.qty * currentPrice;
            const unrealizedPnl = marketValue - p.qty * p.avg_cost;
            return {
                ...p, currentPrice: +currentPrice.toFixed(2), marketValue: +marketValue.toFixed(2),
                unrealizedPnl: +unrealizedPnl.toFixed(2),
                pnlPct: p.avg_cost ? +(((currentPrice - p.avg_cost) / p.avg_cost) * 100).toFixed(2) : 0
            };
        });

        const openOrders = await getAll("SELECT * FROM orders WHERE user_id = $1 AND status = 'open'", [userId]);

        sendJSON(ws, {
            type: 'portfolio',
            cash: user.cash,
            positions: enriched,
            openOrders
        });
    } catch (e) {
        console.error('Portfolio Update Error:', e);
    }
}

async function broadcastOrderBooks() {
    // Collect unique subscribed tickers
    const tickers = new Set();
    for (const [ws, state] of clients) {
        if (ws.readyState !== WebSocket.OPEN || !state.authenticated) continue;
        if (state.subscriptions.has('all')) {
            // Only send top-10 most popular tickers for 'all' to save bandwidth
            engine.TICKER_LIST.slice(0, 10).forEach(t => tickers.add(t));
        } else {
            state.subscriptions.forEach(t => tickers.add(t));
        }
    }

    // We can run this in parallel for subscribed tickers? Or just sequential.
    // Sequential DB calls might be slow if many tickers.
    // But getOpenOrdersByTicker is just a SELECT.

    // Optimization: Get ALL open orders once, then filter in memory?
    // If we have 1000s of orders, in-memory filtering is faster than 100 DB calls.
    // Let's stick to per-ticker for now unless it's too slow.

    try {
        for (const ticker of tickers) {
            const userOrders = await getAll("SELECT * FROM orders WHERE ticker = $1 AND status = 'open'", [ticker]);
            const book = orderbook.generateBook(ticker, userOrders);

            for (const [ws, state] of clients) {
                if (ws.readyState !== WebSocket.OPEN || !state.authenticated) continue;
                if (state.subscriptions.has(ticker) || state.subscriptions.has('all')) {
                    sendJSON(ws, { type: 'orderbook', data: book });
                }
            }
        }
    } catch (e) {
        console.error('Broadcast Orderbook Error:', e);
    }
}

function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const [ws, state] of clients) {
        if (ws.readyState === WebSocket.OPEN && state.authenticated) {
            try { ws.send(payload); } catch (e) { }
        }
    }
}

function sendJSON(ws, obj) {
    if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch (e) { }
    }
}

module.exports = { init };
