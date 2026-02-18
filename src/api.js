const express = require('express');
const { v4: uuid } = require('uuid');
const { stmts } = require('./db');
const { register, login, authenticate } = require('./auth');
const engine = require('./engine');
const orderbook = require('./orderbook');

const router = express.Router();

// ─── Auth Routes ───────────────────────────────────────────────────────────────
router.post('/auth/register', (req, res) => {
    try {
        const result = register(req.body.username, req.body.password);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/auth/login', (req, res) => {
    try {
        const result = login(req.body.username, req.body.password);
        res.json(result);
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
});

router.get('/me', authenticate, (req, res) => {
    const user = stmts.getUserById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
});

// ─── Ticker / Market Data ──────────────────────────────────────────────────────
router.get('/tickers', (req, res) => {
    const defs = engine.getAllTickerDefs();
    const prices = engine.getAllPrices();
    const result = {};
    for (const [ticker, def] of Object.entries(defs)) {
        const p = prices[ticker];
        result[ticker] = {
            ...def, ticker,
            price: p?.price, bid: p?.bid, ask: p?.ask,
            open: p?.open, high: p?.high, low: p?.low,
            prevClose: p?.prevClose, volume: p?.volume,
            change: p ? +(p.price - p.prevClose).toFixed(engine.getDecimals(ticker)) : 0,
            changePct: p && p.prevClose ? +(((p.price - p.prevClose) / p.prevClose) * 100).toFixed(2) : 0
        };
    }
    res.json(result);
});

router.get('/candles/:ticker', (req, res) => {
    const { ticker } = req.params;
    const interval = req.query.interval || '1m';
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);

    const candles = stmts.getCandles.all(ticker.toUpperCase(), interval, limit);
    // Return in chronological order
    candles.reverse();

    // Append current candle
    const current = engine.getCurrentCandle(ticker.toUpperCase(), interval);
    if (current) {
        candles.push({
            ticker: ticker.toUpperCase(),
            interval,
            open_time: current.openTime,
            open: current.open,
            high: current.high,
            low: current.low,
            close: current.close,
            volume: current.volume
        });
    }

    res.json(candles);
});

router.get('/orderbook/:ticker', (req, res) => {
    const { ticker } = req.params;
    const userOrders = stmts.getOpenOrdersByTicker.all(ticker.toUpperCase());
    const book = orderbook.generateBook(ticker.toUpperCase(), userOrders);
    res.json(book);
});

// ─── Orders ────────────────────────────────────────────────────────────────────
router.post('/orders', authenticate, (req, res) => {
    try {
        const { ticker, type, side, qty, limitPrice, stopPrice, trailPct, ocoId } = req.body;

        // Validation
        if (!ticker || !type || !side || !qty) {
            return res.status(400).json({ error: 'Missing required fields: ticker, type, side, qty' });
        }
        if (!engine.getTickerDef(ticker.toUpperCase())) {
            return res.status(400).json({ error: 'Invalid ticker' });
        }
        if (!['buy', 'sell'].includes(side)) {
            return res.status(400).json({ error: 'Side must be buy or sell' });
        }
        if (qty <= 0) {
            return res.status(400).json({ error: 'Quantity must be positive' });
        }

        const validTypes = ['market', 'limit', 'stop', 'stop-loss', 'stop-limit', 'take-profit', 'trailing-stop'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: `Invalid order type. Must be: ${validTypes.join(', ')}` });
        }

        // Check buying power for buy orders
        const user = stmts.getUserById.get(req.user.id);
        const priceData = engine.getPrice(ticker.toUpperCase());
        if (side === 'buy' && type === 'market') {
            const estimatedCost = qty * priceData.ask;
            if (estimatedCost > user.cash) {
                return res.status(400).json({ error: `Insufficient funds. Need $${estimatedCost.toFixed(2)}, have $${user.cash.toFixed(2)}` });
            }
        }

        // Check sell qty against position
        if (side === 'sell') {
            const position = stmts.getPosition.get(req.user.id, ticker.toUpperCase());
            const posQty = position ? position.qty : 0;
            // Allow short selling (negative qty)
        }

        const orderId = uuid();
        const now = Date.now();

        stmts.insertOrder.run(
            orderId, req.user.id, ticker.toUpperCase(), type, side,
            qty, limitPrice || null, stopPrice || null,
            trailPct || null, priceData?.price || null,
            ocoId || null, 'open', now
        );

        const order = stmts.getOrderById.get(orderId);
        res.json({ success: true, order });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/orders/:id', authenticate, (req, res) => {
    const order = stmts.getOrderById.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Not your order' });
    if (order.status !== 'open') return res.status(400).json({ error: 'Order is not open' });

    stmts.cancelOrder.run(Date.now(), req.params.id);
    res.json({ success: true });
});

router.get('/orders', authenticate, (req, res) => {
    const orders = stmts.getOpenOrders.all(req.user.id);
    res.json(orders);
});

// ─── Positions ─────────────────────────────────────────────────────────────────
router.get('/positions', authenticate, (req, res) => {
    const positions = stmts.getUserPositions.all(req.user.id);
    // Enrich with current price and P&L
    const enriched = positions.map(p => {
        const priceData = engine.getPrice(p.ticker);
        const currentPrice = priceData?.price || p.avg_cost;
        const marketValue = p.qty * currentPrice;
        const costBasis = p.qty * p.avg_cost;
        const unrealizedPnl = marketValue - costBasis;
        const pnlPct = costBasis !== 0 ? (unrealizedPnl / Math.abs(costBasis)) * 100 : 0;
        return {
            ...p, currentPrice, marketValue: +marketValue.toFixed(2),
            costBasis: +costBasis.toFixed(2),
            unrealizedPnl: +unrealizedPnl.toFixed(2),
            pnlPct: +pnlPct.toFixed(2)
        };
    });
    res.json(enriched);
});

// ─── Trades ────────────────────────────────────────────────────────────────────
router.get('/trades', authenticate, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const trades = stmts.getUserTrades.all(req.user.id, limit);
    res.json(trades);
});

// ─── Leaderboard ───────────────────────────────────────────────────────────────
router.get('/leaderboard', (req, res) => {
    const users = stmts.getAllUsers.all();
    const leaderboard = users.map(user => {
        const positions = stmts.getUserPositions.all(user.id);
        let positionsValue = 0;
        for (const p of positions) {
            const priceData = engine.getPrice(p.ticker);
            if (priceData) positionsValue += p.qty * priceData.price;
        }
        const totalValue = user.cash + positionsValue;
        const allTimeReturn = ((totalValue - user.starting_cash) / user.starting_cash) * 100;

        // Calculate badges
        const badges = [];
        if (totalValue > 50000) badges.push('🐋');
        if (allTimeReturn > 100) badges.push('🦅');
        if (totalValue < user.starting_cash * 0.3) badges.push('💀');
        if (allTimeReturn > 400) badges.push('🚀');

        // Count trades for degen badge
        const trades = stmts.getUserTrades.all(user.id, 200);
        if (trades.length >= 100) badges.push('🔥');

        // Check winning streak for sniper
        let streak = 0, maxStreak = 0;
        for (const t of trades) {
            if (t.pnl > 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
            else streak = 0;
        }
        if (maxStreak >= 10) badges.push('🎯');

        return {
            username: user.username,
            portfolioValue: +totalValue.toFixed(2),
            cash: +user.cash.toFixed(2),
            positionsValue: +positionsValue.toFixed(2),
            allTimeReturn: +allTimeReturn.toFixed(2),
            badges,
            joinedAt: user.created_at
        };
    });

    leaderboard.sort((a, b) => b.portfolioValue - a.portfolioValue);

    // Add ranks
    leaderboard.forEach((entry, i) => { entry.rank = i + 1; });

    res.json(leaderboard);
});

// ─── News ──────────────────────────────────────────────────────────────────────
router.get('/news', (req, res) => {
    const ticker = req.query.ticker;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    let events;
    if (ticker) {
        events = stmts.getNewsByTicker.all(ticker.toUpperCase(), limit);
    } else {
        events = stmts.getRecentNews.all(limit);
    }
    res.json(events);
});

// ─── Portfolio Stats ───────────────────────────────────────────────────────────
router.get('/portfolio/stats', authenticate, (req, res) => {
    const user = stmts.getUserById.get(req.user.id);
    const positions = stmts.getUserPositions.all(req.user.id);
    const trades = stmts.getUserTrades.all(req.user.id, 500);

    let positionsValue = 0;
    for (const p of positions) {
        const priceData = engine.getPrice(p.ticker);
        if (priceData) positionsValue += p.qty * priceData.price;
    }

    const totalValue = user.cash + positionsValue;
    const allTimeReturn = ((totalValue - user.starting_cash) / user.starting_cash) * 100;

    // Win/loss stats
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    const bestTrade = trades.reduce((best, t) => t.pnl > (best?.pnl || -Infinity) ? t : best, null);
    const worstTrade = trades.reduce((worst, t) => t.pnl < (worst?.pnl || Infinity) ? t : worst, null);

    // Most traded ticker
    const tickerCounts = {};
    for (const t of trades) { tickerCounts[t.ticker] = (tickerCounts[t.ticker] || 0) + 1; }
    const mostTraded = Object.entries(tickerCounts).sort((a, b) => b[1] - a[1])[0];

    // Snapshots for performance chart
    const snapshots = stmts.getUserSnapshots.all(req.user.id, 500);

    res.json({
        totalValue: +totalValue.toFixed(2),
        cash: +user.cash.toFixed(2),
        positionsValue: +positionsValue.toFixed(2),
        startingCash: user.starting_cash,
        allTimeReturn: +allTimeReturn.toFixed(2),
        totalTrades: trades.length,
        winRate: +winRate.toFixed(1),
        avgWin: +avgWin.toFixed(2),
        avgLoss: +avgLoss.toFixed(2),
        bestTrade, worstTrade,
        mostTraded: mostTraded ? { ticker: mostTraded[0], count: mostTraded[1] } : null,
        snapshots: snapshots.reverse()
    });
});

module.exports = router;
