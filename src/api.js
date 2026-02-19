const express = require('express');
const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError } = require('./db');
const { register, login, authenticate } = require('./auth');
const engine = require('./engine');
const orderbook = require('./orderbook');

const router = express.Router();
const MAX_ORDER_NOTIONAL_FRACTION = Math.max(0.05, Math.min(1, Number.parseFloat(process.env.MAX_ORDER_NOTIONAL_FRACTION || '0.35')));
const MIN_ORDER_NOTIONAL = Math.max(1, Number.parseFloat(process.env.MIN_ORDER_NOTIONAL || '50'));

function handleRouteError(res, error, defaultStatus = 500) {
    if (isDbUnavailableError(error)) {
        return res.status(503).json({ error: 'db_unavailable' });
    }
    return res.status(defaultStatus).json({ error: error.message || 'Internal server error' });
}

function asyncRoute(handler, defaultStatus = 500) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            handleRouteError(res, error, defaultStatus);
        }
    };
}

// Auth Routes
router.post('/auth/register', asyncRoute(async (req, res) => {
    const result = await register(req.body.username, req.body.password);
    res.json(result);
}, 400));

router.post('/auth/login', async (req, res) => {
    try {
        const result = await login(req.body.username, req.body.password);
        res.json(result);
    } catch (error) {
        if (isDbUnavailableError(error)) {
            return res.status(503).json({ error: 'db_unavailable' });
        }
        return res.status(401).json({ error: error.message });
    }
});

router.get('/me', authenticate, asyncRoute(async (req, res) => {
    const user = await stmts.getUserById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
}));

// Ticker / Market Data
router.get('/tickers', (req, res) => {
    const defs = engine.getAllTickerDefs();
    const prices = engine.getAllPrices();
    const result = {};
    for (const [ticker, def] of Object.entries(defs)) {
        const p = prices[ticker];
        result[ticker] = {
            ...def,
            ticker,
            price: p?.price,
            bid: p?.bid,
            ask: p?.ask,
            open: p?.open,
            high: p?.high,
            low: p?.low,
            prevClose: p?.prevClose,
            volume: p?.volume,
            change: p ? +(p.price - p.prevClose).toFixed(engine.getDecimals(ticker)) : 0,
            changePct: p && p.prevClose ? +(((p.price - p.prevClose) / p.prevClose) * 100).toFixed(2) : 0,
        };
    }
    res.json(result);
});

router.get('/candles/:ticker', asyncRoute(async (req, res) => {
    const { ticker } = req.params;
    const interval = req.query.interval || '1m';
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 500, 2000);

    const candles = await stmts.getCandles.all(ticker.toUpperCase(), interval, limit);
    candles.reverse();

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
            volume: current.volume,
        });
    }

    res.json(candles);
}));

router.get('/orderbook/:ticker', asyncRoute(async (req, res) => {
    const { ticker } = req.params;
    const userOrders = await stmts.getOpenOrdersByTicker.all(ticker.toUpperCase());
    const book = orderbook.generateBook(ticker.toUpperCase(), userOrders);
    res.json(book);
}));

// Orders
router.post('/orders', authenticate, asyncRoute(async (req, res) => {
    const { ticker, type, side, qty, limitPrice, stopPrice, trailPct, ocoId } = req.body;

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

    const user = await stmts.getUserById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const priceData = engine.getPrice(ticker.toUpperCase());
    const referencePrice = type === 'limit'
        ? Number(limitPrice)
        : type === 'stop' || type === 'stop-loss' || type === 'take-profit'
            ? Number(stopPrice || priceData?.price)
            : Number(priceData?.ask || priceData?.price || limitPrice || stopPrice);
    const estimatedNotional = Number(qty) * referencePrice;

    if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
        return res.status(400).json({ error: 'Unable to price order for validation' });
    }
    if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
        return res.status(400).json({ error: 'Invalid order notional' });
    }
    if (estimatedNotional < MIN_ORDER_NOTIONAL) {
        return res.status(400).json({ error: `Order notional must be at least $${MIN_ORDER_NOTIONAL.toFixed(2)}` });
    }

    if (side === 'buy') {
        const maxOrderNotional = user.cash * MAX_ORDER_NOTIONAL_FRACTION;
        if (estimatedNotional > maxOrderNotional) {
            return res.status(400).json({
                error: `Order too large. Max per order is ${(MAX_ORDER_NOTIONAL_FRACTION * 100).toFixed(0)}% of cash ($${maxOrderNotional.toFixed(2)}).`,
            });
        }
    }

    if (side === 'buy' && type === 'market' && priceData) {
        const estimatedCost = qty * priceData.ask;
        if (estimatedCost > user.cash) {
            return res.status(400).json({ error: `Insufficient funds. Need $${estimatedCost.toFixed(2)}, have $${user.cash.toFixed(2)}` });
        }
    }

    const orderId = uuid();
    const now = Date.now();
    await stmts.insertOrder.run(
        orderId,
        req.user.id,
        ticker.toUpperCase(),
        type,
        side,
        qty,
        limitPrice || null,
        stopPrice || null,
        trailPct || null,
        priceData?.price || null,
        ocoId || null,
        'open',
        now
    );

    const order = await stmts.getOrderById.get(orderId);
    res.json({ success: true, order });
}));

router.delete('/orders/:id', authenticate, asyncRoute(async (req, res) => {
    const order = await stmts.getOrderById.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Not your order' });
    if (order.status !== 'open') return res.status(400).json({ error: 'Order is not open' });

    await stmts.cancelOrder.run(Date.now(), req.params.id);
    res.json({ success: true });
}));

router.get('/orders', authenticate, asyncRoute(async (req, res) => {
    const orders = await stmts.getOpenOrders.all(req.user.id);
    res.json(orders);
}));

// Positions
router.get('/positions', authenticate, asyncRoute(async (req, res) => {
    const positions = await stmts.getUserPositions.all(req.user.id);
    const enriched = positions.map((position) => {
        const priceData = engine.getPrice(position.ticker);
        const currentPrice = priceData?.price || position.avg_cost;
        const marketValue = position.qty * currentPrice;
        const costBasis = position.qty * position.avg_cost;
        const unrealizedPnl = marketValue - costBasis;
        const pnlPct = costBasis !== 0 ? (unrealizedPnl / Math.abs(costBasis)) * 100 : 0;
        return {
            ...position,
            currentPrice,
            marketValue: +marketValue.toFixed(2),
            costBasis: +costBasis.toFixed(2),
            unrealizedPnl: +unrealizedPnl.toFixed(2),
            pnlPct: +pnlPct.toFixed(2),
        };
    });
    res.json(enriched);
}));

// Trades
router.get('/trades', authenticate, asyncRoute(async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 500);
    const trades = await stmts.getUserTrades.all(req.user.id, limit);
    res.json(trades);
}));

// Leaderboard
router.get('/leaderboard', asyncRoute(async (req, res) => {
    // Fetch all data in 3 queries instead of N+1
    const [users, allPositions, allTrades] = await Promise.all([
        stmts.getAllUsers.all(),
        stmts.getAllPositions.all(),
        stmts.getAllTrades.all(),
    ]);

    // Group positions by user_id
    const positionsByUser = new Map();
    for (const pos of allPositions) {
        if (!positionsByUser.has(pos.user_id)) {
            positionsByUser.set(pos.user_id, []);
        }
        positionsByUser.get(pos.user_id).push(pos);
    }

    // Group trades by user_id (keep only first 200 per user for badge calculations)
    const tradesByUser = new Map();
    const userTradeCounts = new Map();
    for (const trade of allTrades) {
        if (!tradesByUser.has(trade.user_id)) {
            tradesByUser.set(trade.user_id, []);
            userTradeCounts.set(trade.user_id, 0);
        }
        const count = userTradeCounts.get(trade.user_id);
        if (count < 200) {
            tradesByUser.get(trade.user_id).push(trade);
            userTradeCounts.set(trade.user_id, count + 1);
        }
    }

    const leaderboard = [];

    for (const user of users) {
        const positions = positionsByUser.get(user.id) || [];
        let positionsValue = 0;
        for (const position of positions) {
            const priceData = engine.getPrice(position.ticker);
            if (priceData) positionsValue += position.qty * priceData.price;
        }

        const totalValue = user.cash + positionsValue;
        const allTimeReturn = ((totalValue - user.starting_cash) / user.starting_cash) * 100;

        const badges = [];
        if (totalValue > 50000) badges.push('🐋');
        if (allTimeReturn > 100) badges.push('🦅');
        if (totalValue < user.starting_cash * 0.3) badges.push('💀');
        if (allTimeReturn > 400) badges.push('🚀');

        const trades = tradesByUser.get(user.id) || [];
        if (trades.length >= 100) badges.push('🔥');

        let streak = 0;
        let maxStreak = 0;
        for (const trade of trades) {
            if (trade.pnl > 0) {
                streak += 1;
                maxStreak = Math.max(maxStreak, streak);
            } else {
                streak = 0;
            }
        }
        if (maxStreak >= 10) badges.push('🎯');

        leaderboard.push({
            username: user.username,
            portfolioValue: +totalValue.toFixed(2),
            cash: +user.cash.toFixed(2),
            positionsValue: +positionsValue.toFixed(2),
            allTimeReturn: +allTimeReturn.toFixed(2),
            badges,
            joinedAt: user.created_at,
        });
    }

    leaderboard.sort((a, b) => b.portfolioValue - a.portfolioValue);
    leaderboard.forEach((entry, index) => {
        entry.rank = index + 1;
    });

    res.json(leaderboard);
}));

// News
router.get('/news', asyncRoute(async (req, res) => {
    const ticker = req.query.ticker;
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);

    let events;
    if (ticker) {
        events = await stmts.getNewsByTicker.all(ticker.toUpperCase(), limit);
    } else {
        events = await stmts.getRecentNews.all(limit);
    }
    res.json(events);
}));

// Portfolio Stats
router.get('/portfolio/stats', authenticate, asyncRoute(async (req, res) => {
    const user = await stmts.getUserById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const positions = await stmts.getUserPositions.all(req.user.id);
    const trades = await stmts.getUserTrades.all(req.user.id, 500);

    let positionsValue = 0;
    for (const position of positions) {
        const priceData = engine.getPrice(position.ticker);
        if (priceData) positionsValue += position.qty * priceData.price;
    }

    const totalValue = user.cash + positionsValue;
    const allTimeReturn = ((totalValue - user.starting_cash) / user.starting_cash) * 100;

    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl < 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((sum, trade) => sum + trade.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length : 0;

    const bestTrade = trades.reduce((best, trade) => (trade.pnl > (best?.pnl || -Infinity) ? trade : best), null);
    const worstTrade = trades.reduce((worst, trade) => (trade.pnl < (worst?.pnl || Infinity) ? trade : worst), null);

    const tickerCounts = {};
    for (const trade of trades) {
        tickerCounts[trade.ticker] = (tickerCounts[trade.ticker] || 0) + 1;
    }
    const mostTraded = Object.entries(tickerCounts).sort((a, b) => b[1] - a[1])[0];

    const snapshots = await stmts.getUserSnapshots.all(req.user.id, 500);

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
        bestTrade,
        worstTrade,
        mostTraded: mostTraded ? { ticker: mostTraded[0], count: mostTraded[1] } : null,
        snapshots: snapshots.reverse(),
    });
}));

// ============================================================
// FUND HELPERS
// ============================================================

async function getFundWithMembership(fundId, userId) {
    const fund = await stmts.getFundById.get(fundId);
    if (!fund) return { fund: null, membership: null };
    const membership = await stmts.getFundMember.get(fundId, userId);
    return { fund, membership };
}

function requireFundMember(req, res, next) {
    (async () => {
        const { id } = req.params;
        const { fund, membership } = await getFundWithMembership(id, req.user.id);
        if (!fund) return res.status(404).json({ error: 'Fund not found' });
        if (!membership) return res.status(403).json({ error: 'Not a member of this fund' });
        req.fund = fund;
        req.membership = membership;
        next();
    })().catch(next);
}

function requireFundOwner(req, res, next) {
    (async () => {
        const { id } = req.params;
        const { fund, membership } = await getFundWithMembership(id, req.user.id);
        if (!fund) return res.status(404).json({ error: 'Fund not found' });
        if (!membership || membership.role !== 'owner') {
            return res.status(403).json({ error: 'Owner access required' });
        }
        req.fund = fund;
        req.membership = membership;
        next();
    })().catch(next);
}

// ============================================================
// FUND ENDPOINTS
// ============================================================

// Create a new fund (auth required)
router.post('/funds', authenticate, asyncRoute(async (req, res) => {
    const { name, strategy_type, description, min_investment, management_fee, performance_fee } = req.body;

    if (!name || !strategy_type) {
        return res.status(400).json({ error: 'Missing required fields: name, strategy_type' });
    }

    const fundId = uuid();
    const now = Date.now();

    await stmts.insertFund.run(
        fundId,
        name,
        req.user.id,
        strategy_type,
        description || null,
        min_investment || 0,
        management_fee || 0,
        performance_fee || 0,
        now
    );

    // Auto-add creator as owner
    const memberId = uuid();
    await stmts.insertFundMember.run(memberId, fundId, req.user.id, 'owner', now);

    const fund = await stmts.getFundById.get(fundId);
    res.status(201).json({ success: true, fund });
}));

// List all funds (public)
router.get('/funds', asyncRoute(async (req, res) => {
    const funds = await stmts.getAllFunds.all();
    res.json(funds);
}));

// Get fund details (public)
router.get('/funds/:id', asyncRoute(async (req, res) => {
    const fund = await stmts.getFundById.get(req.params.id);
    if (!fund) return res.status(404).json({ error: 'Fund not found' });
    res.json(fund);
}));

// Get funds user owns or is member of (auth required)
router.get('/funds/my', authenticate, asyncRoute(async (req, res) => {
    const funds = await stmts.getUserFunds.all(req.user.id);
    res.json(funds);
}));

// Update fund (owner only)
router.put('/funds/:id', authenticate, requireFundOwner, asyncRoute(async (req, res) => {
    const { name, strategy_type, description, min_investment, management_fee, performance_fee } = req.body;

    await stmts.updateFund.run(
        name || req.fund.name,
        strategy_type || req.fund.strategy_type,
        description !== undefined ? description : req.fund.description,
        min_investment !== undefined ? min_investment : req.fund.min_investment,
        management_fee !== undefined ? management_fee : req.fund.management_fee,
        performance_fee !== undefined ? performance_fee : req.fund.performance_fee,
        req.params.id
    );

    const fund = await stmts.getFundById.get(req.params.id);
    res.json({ success: true, fund });
}));

// Delete fund (owner only)
router.delete('/funds/:id', authenticate, requireFundOwner, asyncRoute(async (req, res) => {
    await stmts.deleteFund.run(req.params.id);
    res.json({ success: true });
}));

// ============================================================
// FUND MEMBER ENDPOINTS
// ============================================================

// Add member to fund (owner/analyst only)
router.post('/funds/:id/members', authenticate, requireFundMember, asyncRoute(async (req, res) => {
    const { role } = req.membership;

    if (role !== 'owner' && role !== 'analyst') {
        return res.status(403).json({ error: 'Only owners and analysts can add members' });
    }

    const { user_id, role: newRole } = req.body;

    if (!user_id || !newRole) {
        return res.status(400).json({ error: 'Missing required fields: user_id, role' });
    }

    const validRoles = ['analyst', 'client'];
    if (!validRoles.includes(newRole)) {
        return res.status(400).json({ error: `Invalid role. Must be: ${validRoles.join(', ')}` });
    }

    // Check if already a member
    const existing = await stmts.getFundMember.get(req.params.id, user_id);
    if (existing) {
        return res.status(400).json({ error: 'User is already a member of this fund' });
    }

    const memberId = uuid();
    await stmts.insertFundMember.run(memberId, req.params.id, user_id, newRole, Date.now());

    const members = await stmts.getFundMembers.all(req.params.id);
    const newMember = members.find(m => m.user_id === user_id);
    res.status(201).json({ success: true, member: newMember });
}));

// List fund members (fund members only)
router.get('/funds/:id/members', authenticate, requireFundMember, asyncRoute(async (req, res) => {
    const members = await stmts.getFundMembers.all(req.params.id);
    res.json(members);
}));

// Update member role (owner only)
router.put('/funds/:id/members/:userId', authenticate, requireFundOwner, asyncRoute(async (req, res) => {
    const { userId } = req.params;
    const { role } = req.body;

    if (!role) {
        return res.status(400).json({ error: 'Missing required field: role' });
    }

    const membership = await stmts.getFundMember.get(req.params.id, userId);
    if (!membership) {
        return res.status(404).json({ error: 'Member not found' });
    }

    if (membership.role === 'owner') {
        return res.status(400).json({ error: 'Cannot modify owner role' });
    }

    const validRoles = ['analyst', 'client'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ error: `Invalid role. Must be: ${validRoles.join(', ')}` });
    }

    await stmts.updateFundMemberRole.run(role, req.params.id, userId);
    const members = await stmts.getFundMembers.all(req.params.id);
    const updatedMember = members.find(m => m.user_id === userId);
    res.json({ success: true, member: updatedMember });
}));

// Remove member (owner only)
router.delete('/funds/:id/members/:userId', authenticate, requireFundOwner, asyncRoute(async (req, res) => {
    const { userId } = req.params;

    const membership = await stmts.getFundMember.get(req.params.id, userId);
    if (!membership) {
        return res.status(404).json({ error: 'Member not found' });
    }

    if (membership.role === 'owner') {
        return res.status(400).json({ error: 'Cannot remove owner' });
    }

    await stmts.deleteFundMember.run(req.params.id, userId);
    res.json({ success: true });
}));

// ============================================================
// FUND CAPITAL ENDPOINTS
// ============================================================

// Deposit/withdraw capital (auth required)
router.post('/funds/:id/capital', authenticate, requireFundMember, asyncRoute(async (req, res) => {
    const { amount, type } = req.body;

    if (!amount || !type) {
        return res.status(400).json({ error: 'Missing required fields: amount, type' });
    }

    if (amount <= 0) {
        return res.status(400).json({ error: 'Amount must be positive' });
    }

    const validTypes = ['deposit', 'withdrawal'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be: ${validTypes.join(', ')}` });
    }

    const capitalId = uuid();
    await stmts.insertFundCapital.run(capitalId, req.params.id, req.user.id, amount, type, Date.now());

    const transaction = await stmts.getFundCapitalById.get(capitalId);
    res.status(201).json({ success: true, transaction });
}));

// Get capital transactions (fund members only)
router.get('/funds/:id/capital', authenticate, requireFundMember, asyncRoute(async (req, res) => {
    const transactions = await stmts.getFundCapitalTransactions.all(req.params.id);
    res.json(transactions);
}));

// Get capital summary by user (fund members only)
router.get('/funds/:id/capital/summary', authenticate, requireFundMember, asyncRoute(async (req, res) => {
    const summary = await stmts.getFundCapitalSummary.all(req.params.id, 'deposit');
    res.json(summary);
}));

module.exports = router;
