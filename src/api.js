const express = require('express');
const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError, runInTransaction } = require('./db');
const { register, login, authenticate } = require('./auth');
const engine = require('./engine');
const orderbook = require('./orderbook');
const strategyRunner = require('./strategyRunner');
const backtester = require('./backtester');
const clientPortal = require('./routes/clientPortal');
const { estimateOrder, isExecutionRealismEnabled } = require('./executionModel');
const {
    round2,
    round8,
    normalizeCapitalTransactions,
    normalizeNavSnapshots,
    sumNetCapital,
    sumUnits,
    computeReconciliation,
} = require('./metrics/fundMetrics');

const router = express.Router();
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
    const regime = engine.getCurrentRegime ? engine.getCurrentRegime() : { regime: 'normal' };
    const result = {};
    for (const [ticker, def] of Object.entries(defs)) {
        const p = prices[ticker];
        const spreadBps = (p?.bid > 0 && p?.ask > 0)
            ? (((p.ask - p.bid) / ((p.ask + p.bid) / 2)) * 10000)
            : Number(def.base_spread_bps || 0);
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
            spread_bps: +Number(spreadBps || 0).toFixed(4),
            liquidity_score: Number(def.liquidity_score || 0),
            borrow_apr_short: Number(def.borrow_apr_short || 0),
            regime: regime.regime || 'normal',
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
    const existingPosition = await stmts.getPosition.get(req.user.id, ticker.toUpperCase());

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

    if (side === 'buy' && type === 'market' && priceData) {
        const estimatedCost = qty * priceData.ask;
        if (estimatedCost > user.cash) {
            return res.status(400).json({ error: `Insufficient funds. Need $${estimatedCost.toFixed(2)}, have $${user.cash.toFixed(2)}` });
        }
    }

    const currentQty = Number(existingPosition?.qty || 0);
    const longInventory = Math.max(0, currentQty);
    const opensShortQty = side === 'sell'
        ? Math.max(0, Number(qty) - longInventory)
        : 0;
    const midPrice = (Number(priceData?.bid || referencePrice) + Number(priceData?.ask || referencePrice)) / 2;
    const estimatedExecution = estimateOrder({
        tickerDef: engine.getTickerDef(ticker.toUpperCase()) || {},
        side,
        qty: Number(qty),
        reference_price: referencePrice,
        mid_price: Number.isFinite(midPrice) && midPrice > 0 ? midPrice : referencePrice,
        volatility: Number(priceData?.volatility || 0),
        opens_short_qty: opensShortQty,
        regime: engine.getCurrentRegime ? engine.getCurrentRegime() : null,
    });

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
    res.json({
        success: true,
        order,
        estimated_execution: {
            ...estimatedExecution,
            apply_realism: isExecutionRealismEnabled(),
        },
    });
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
    const tradeCostByUser = new Map();
    for (const trade of allTrades) {
        if (!tradesByUser.has(trade.user_id)) {
            tradesByUser.set(trade.user_id, []);
            userTradeCounts.set(trade.user_id, 0);
            tradeCostByUser.set(trade.user_id, {
                totalSlippageCost: 0,
                totalCommission: 0,
                totalBorrowCost: 0,
                totalExecutionCost: 0,
            });
        }
        const aggregateCosts = tradeCostByUser.get(trade.user_id);
        aggregateCosts.totalSlippageCost += Number(trade.slippage_cost || 0);
        aggregateCosts.totalCommission += Number(trade.commission || 0);
        aggregateCosts.totalBorrowCost += Number(trade.borrow_cost || 0);
        aggregateCosts.totalExecutionCost = aggregateCosts.totalSlippageCost
            + aggregateCosts.totalCommission
            + aggregateCosts.totalBorrowCost;
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

        const trades = tradesByUser.get(user.id) || [];
        const costAgg = tradeCostByUser.get(user.id) || aggregateTradeCosts(trades);
        const netPortfolioValue = user.cash + positionsValue;
        const grossPortfolioValue = netPortfolioValue + costAgg.totalExecutionCost;
        const baseCapital = Number(user.starting_cash || 0);
        const netReturn = baseCapital > 0
            ? ((netPortfolioValue - baseCapital) / baseCapital) * 100
            : 0;
        const grossReturn = baseCapital > 0
            ? ((grossPortfolioValue - baseCapital) / baseCapital) * 100
            : 0;
        const costDragPct = Math.abs(grossReturn) > 0
            ? (Math.abs(grossReturn - netReturn) / Math.abs(grossReturn)) * 100
            : 0;

        const badges = [];
        if (netPortfolioValue > 50000) badges.push('🐋');
        if (netReturn > 100) badges.push('🦅');
        if (baseCapital > 0 && netPortfolioValue < baseCapital * 0.3) badges.push('💀');
        if (netReturn > 400) badges.push('🚀');
        if (trades.length >= 100) badges.push('🔥');
        if (costDragPct <= 6 && trades.length >= 10) badges.push('🧠');

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
            portfolioValue: +netPortfolioValue.toFixed(2),
            net_portfolio_value: +netPortfolioValue.toFixed(2),
            gross_portfolio_value: +grossPortfolioValue.toFixed(2),
            cash: +user.cash.toFixed(2),
            positionsValue: +positionsValue.toFixed(2),
            allTimeReturn: +netReturn.toFixed(2),
            net_return: +netReturn.toFixed(2),
            gross_return: +grossReturn.toFixed(2),
            total_slippage_cost: +costAgg.totalSlippageCost.toFixed(2),
            total_commission: +costAgg.totalCommission.toFixed(2),
            total_borrow_cost: +costAgg.totalBorrowCost.toFixed(2),
            cost_drag_pct: +costDragPct.toFixed(2),
            execution_discipline: costDragPct <= 6 ? 'high' : costDragPct <= 14 ? 'medium' : 'low',
            badges,
            joinedAt: user.created_at,
        });
    }

    leaderboard.sort((a, b) => b.net_portfolio_value - a.net_portfolio_value);
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
    const netPnl = totalValue - user.starting_cash;
    const costAgg = aggregateTradeCosts(trades);
    const grossPnl = netPnl + costAgg.totalExecutionCost;
    const grossPortfolioValue = user.starting_cash + grossPnl;
    const grossReturn = user.starting_cash > 0
        ? ((grossPortfolioValue - user.starting_cash) / user.starting_cash) * 100
        : 0;
    const costDragPct = Math.abs(grossPnl) > 0
        ? (costAgg.totalExecutionCost / Math.abs(grossPnl)) * 100
        : 0;

    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl < 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    const resolvedTrades = wins.length + losses.length;
    const netWinRate = resolvedTrades > 0 ? (wins.length / resolvedTrades) * 100 : 0;
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

    const asOf = Date.now();
    res.json({
        as_of: asOf,
        totalValue: +totalValue.toFixed(2),
        gross_portfolio_value: +grossPortfolioValue.toFixed(2),
        net_portfolio_value: +totalValue.toFixed(2),
        cash: +user.cash.toFixed(2),
        positionsValue: +positionsValue.toFixed(2),
        startingCash: user.starting_cash,
        allTimeReturn: +allTimeReturn.toFixed(2),
        gross_return: +grossReturn.toFixed(2),
        net_return: +allTimeReturn.toFixed(2),
        gross_pnl: +grossPnl.toFixed(2),
        net_pnl: +netPnl.toFixed(2),
        total_slippage_cost: +costAgg.totalSlippageCost.toFixed(2),
        total_commission: +costAgg.totalCommission.toFixed(2),
        total_borrow_cost: +costAgg.totalBorrowCost.toFixed(2),
        total_execution_cost: +costAgg.totalExecutionCost.toFixed(2),
        cost_drag_pct: +costDragPct.toFixed(2),
        totalTrades: trades.length,
        winRate: +winRate.toFixed(1),
        net_win_rate: +netWinRate.toFixed(1),
        avgWin: +avgWin.toFixed(2),
        avgLoss: +avgLoss.toFixed(2),
        bestTrade,
        worstTrade,
        mostTraded: mostTraded ? { ticker: mostTraded[0], count: mostTraded[1] } : null,
        snapshots: snapshots.reverse(),
        calculation_basis: {
            portfolio_value: 'cash_plus_mark_to_market_positions',
            all_time_return: 'portfolio_value_minus_starting_cash_over_starting_cash',
            trade_stats: 'realized_trade_pnl_ledger',
            gross_pnl: 'net_pnl_plus_execution_costs',
            net_pnl: 'portfolio_value_minus_starting_cash',
        },
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

function aggregateTradeCosts(trades = []) {
    let totalSlippageCost = 0;
    let totalCommission = 0;
    let totalBorrowCost = 0;
    for (const trade of trades) {
        totalSlippageCost += Number(trade.slippage_cost || 0);
        totalCommission += Number(trade.commission || 0);
        totalBorrowCost += Number(trade.borrow_cost || 0);
    }
    const totalExecutionCost = totalSlippageCost + totalCommission + totalBorrowCost;
    return {
        totalSlippageCost,
        totalCommission,
        totalBorrowCost,
        totalExecutionCost,
    };
}

function hasFundManagerAccess(membership) {
    return Boolean(membership && (membership.role === 'owner' || membership.role === 'analyst'));
}

function requireFundAnalyst(req, res, next) {
    (async () => {
        const { id } = req.params;
        const { fund, membership } = await getFundWithMembership(id, req.user.id);
        if (!fund) return res.status(404).json({ error: 'Fund not found' });
        if (!hasFundManagerAccess(membership)) {
            return res.status(403).json({ error: 'Analyst or owner access required' });
        }
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

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeRiskSettingsPayload(payload, currentSettings) {
    const base = currentSettings || strategyRunner.FUND_RISK_DEFAULTS;
    return {
        max_position_pct: clampNumber(
            payload.max_position_pct !== undefined ? payload.max_position_pct : base.max_position_pct,
            base.max_position_pct,
            1,
            100
        ),
        max_strategy_allocation_pct: clampNumber(
            payload.max_strategy_allocation_pct !== undefined ? payload.max_strategy_allocation_pct : base.max_strategy_allocation_pct,
            base.max_strategy_allocation_pct,
            1,
            100
        ),
        max_daily_drawdown_pct: clampNumber(
            payload.max_daily_drawdown_pct !== undefined ? payload.max_daily_drawdown_pct : base.max_daily_drawdown_pct,
            base.max_daily_drawdown_pct,
            0.1,
            100
        ),
        is_enabled: payload.is_enabled !== undefined ? Boolean(payload.is_enabled) : Boolean(base.is_enabled),
    };
}

function summarizeBacktestRecord(row) {
    if (!row) return null;
    let metrics = row.metrics || {};
    let thresholds = row.thresholds || {};
    if (typeof metrics === 'string') {
        try { metrics = JSON.parse(metrics || '{}'); } catch { metrics = {}; }
    }
    if (typeof thresholds === 'string') {
        try { thresholds = JSON.parse(thresholds || '{}'); } catch { thresholds = {}; }
    }
    return {
        id: row.id,
        strategy_id: row.strategy_id,
        fund_id: row.fund_id,
        config_hash: row.config_hash,
        passed: Boolean(row.passed),
        notes: row.notes || '',
        ran_at: Number(row.ran_at),
        metrics,
        thresholds,
    };
}

function toNum(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getSafeNavPerUnit(nav, totalUnits) {
    const units = toNum(totalUnits, 0);
    const navValue = toNum(nav, 0);
    if (units <= 0) return 1;
    return Math.max(0.0001, navValue / units);
}

async function getFundLedgerState(fundId) {
    const transactionsRaw = await stmts.getFundCapitalTransactions.all(fundId);
    const transactions = normalizeCapitalTransactions(transactionsRaw);
    return {
        transactions,
        netCapital: sumNetCapital(transactions),
        totalUnits: sumUnits(transactions),
    };
}

async function getUserFundLedgerState(fundId, userId) {
    const transactionsRaw = await stmts.getUserCapitalInFund.all(fundId, userId);
    const transactions = normalizeCapitalTransactions(transactionsRaw);
    return {
        transactions,
        netCapital: sumNetCapital(transactions),
        totalUnits: sumUnits(transactions),
    };
}

function buildInvestorLedgerFromTransactions(transactions, navPerUnit, totalUnits) {
    const byUser = new Map();
    for (const tx of transactions || []) {
        const userId = tx.userId;
        if (!userId) continue;
        if (!byUser.has(userId)) {
            byUser.set(userId, {
                user_id: userId,
                username: tx.username || userId,
                units: 0,
                netCapital: 0,
            });
        }
        const current = byUser.get(userId);
        current.units += toNum(tx.unitsDelta, 0);
        current.netCapital += tx.type === 'deposit' ? toNum(tx.amount, 0) : -toNum(tx.amount, 0);
    }

    return Array.from(byUser.values())
        .filter((row) => Math.abs(toNum(row.units, 0)) > 1e-7)
        .map((row) => {
            const units = toNum(row.units, 0);
            const netCapital = toNum(row.netCapital, 0);
            const value = units * toNum(navPerUnit, 1);
            const ownershipPct = toNum(totalUnits, 0) > 0 ? (units / toNum(totalUnits, 0)) * 100 : 0;
            return {
                user_id: row.user_id,
                username: row.username,
                units: +units.toFixed(8),
                netCapital: +netCapital.toFixed(2),
                value: +value.toFixed(2),
                ownershipPct: +ownershipPct.toFixed(4),
                pnl: +(value - netCapital).toFixed(2),
            };
        })
        .sort((a, b) => b.units - a.units);
}

async function getFundNavState(fundId) {
    let utilization = null;
    try {
        utilization = await strategyRunner.getFundRiskSnapshot(fundId);
    } catch {
        utilization = null;
    }

    const fundLedger = await getFundLedgerState(fundId);

    const capital = toNum(utilization?.capital, toNum(fundLedger.netCapital, 0));
    const pnl = toNum(utilization?.totalPnl, 0);
    const nav = toNum(utilization?.equity, capital + pnl);
    const totalUnits = toNum(fundLedger.totalUnits, 0);
    const navPerUnit = getSafeNavPerUnit(nav, totalUnits);

    return {
        capital: +capital.toFixed(2),
        pnl: +pnl.toFixed(2),
        nav: +nav.toFixed(2),
        totalUnits: +totalUnits.toFixed(8),
        navPerUnit: +navPerUnit.toFixed(8),
        dailyDrawdownPct: toNum(utilization?.dailyDrawdownPct, 0),
        utilization: utilization || null,
    };
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

// Get funds user owns or is member of (auth required)
// NOTE: Must be before /funds/:id so Express doesn't match "my" as an :id
router.get('/funds/my', authenticate, asyncRoute(async (req, res) => {
    const funds = await stmts.getUserFunds.all(req.user.id);
    res.json(funds);
}));

// Get fund details (public)
router.get('/funds/:id', asyncRoute(async (req, res) => {
    const fund = await stmts.getFundById.get(req.params.id);
    if (!fund) return res.status(404).json({ error: 'Fund not found' });
    res.json(fund);
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

// Delete fund (owner only) — cascade delete all related records
router.delete('/funds/:id', authenticate, requireFundOwner, asyncRoute(async (req, res) => {
    const fundId = req.params.id;

    // Delete strategy trades for all strategies in this fund
    const strategies = await stmts.getStrategiesByFund.all(fundId);
    const customStrategies = await stmts.getCustomStrategiesByFund.all(fundId);
    for (const s of strategies) {
        await stmts.deleteStrategyTrades.run(s.id);
        await stmts.deleteStrategy.run(s.id);
    }
    for (const s of customStrategies) {
        await stmts.deleteCustomStrategy.run(s.id);
    }

    // Delete capital, members, then the fund
    await stmts.deleteFundStrategyBacktests.run(fundId);
    await stmts.deleteFundNavSnapshots.run(fundId);
    await stmts.deleteFundRiskBreaches.run(fundId);
    await stmts.deleteFundRiskSettings.run(fundId);
    await stmts.deleteFundCapital.run(fundId);
    await stmts.deleteFundMembers.run(fundId);
    await stmts.deleteFund.run(fundId);

    res.json({ success: true });
}));

// ============================================================
// FUND MEMBER ENDPOINTS
// ============================================================

// Add member to fund (owner/analyst only)
router.post('/funds/:id/members', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const { username, role: newRole } = req.body;

    if (!username || !newRole) {
        return res.status(400).json({ error: 'Missing required fields: username, role' });
    }

    const validRoles = ['analyst', 'client'];
    if (!validRoles.includes(newRole)) {
        return res.status(400).json({ error: `Invalid role. Must be: ${validRoles.join(', ')}` });
    }

    // Look up user by username
    const targetUser = await stmts.getUserByUsername.get(username.toLowerCase());
    if (!targetUser) {
        return res.status(404).json({ error: `User "${username}" not found` });
    }
    const user_id = targetUser.id;

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

// List fund members (analyst/owner only)
router.get('/funds/:id/members', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
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

// Deposit/withdraw capital (analyst/owner only)
router.post('/funds/:id/capital', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const { amount: rawAmount, type } = req.body;
    const parsedAmount = Number(rawAmount);

    if (!Number.isFinite(parsedAmount) || !type) {
        return res.status(400).json({ error: 'Missing required fields: amount, type' });
    }

    if (parsedAmount <= 0) {
        return res.status(400).json({ error: 'Amount must be positive' });
    }
    const amount = +parsedAmount.toFixed(2);

    const validTypes = ['deposit', 'withdrawal'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be: ${validTypes.join(', ')}` });
    }

    const capitalId = uuid();
    const now = Date.now();
    const fundNavState = await getFundNavState(req.params.id);
    const fundPnl = toNum(fundNavState.pnl, 0);

    const result = await runInTransaction('fundsCapitalTransfer', async (client) => {
        const userResult = await client.query(
            'SELECT cash FROM users WHERE id = $1 FOR UPDATE',
            [req.user.id]
        );
        if (userResult.rowCount === 0) {
            return { error: 'User not found', status: 404 };
        }

        const userCash = Number(userResult.rows[0].cash);

        await client.query('SELECT id FROM fund_capital WHERE fund_id = $1 FOR UPDATE', [req.params.id]);
        const [fundAggResult, userAggResult] = await Promise.all([
            client.query(
                `
                SELECT
                    COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) as net_capital,
                    COALESCE(SUM(units_delta), 0) as total_units
                FROM fund_capital
                WHERE fund_id = $1
                `,
                [req.params.id]
            ),
            client.query(
                `
                SELECT
                    COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0) as net_capital,
                    COALESCE(SUM(units_delta), 0) as total_units
                FROM fund_capital
                WHERE fund_id = $1 AND user_id = $2
                `,
                [req.params.id, req.user.id]
            ),
        ]);

        const fundCapitalBefore = toNum(fundAggResult.rows[0]?.net_capital, 0);
        const fundUnitsBefore = toNum(fundAggResult.rows[0]?.total_units, 0);
        const userCapital = toNum(userAggResult.rows[0]?.net_capital, 0);
        const userUnitsBefore = toNum(userAggResult.rows[0]?.total_units, 0);

        const navBefore = fundCapitalBefore + fundPnl;
        const navPerUnitBefore = getSafeNavPerUnit(navBefore, fundUnitsBefore);

        if (type === 'deposit' && amount > userCash + 1e-6) {
            return { error: `Insufficient cash. Available ${userCash.toFixed(2)}`, status: 400 };
        }
        const userValueBefore = userUnitsBefore * navPerUnitBefore;
        if (type === 'withdrawal' && amount > userValueBefore + 1e-6) {
            return { error: `Insufficient investor value in fund. Available ${userValueBefore.toFixed(2)}`, status: 400 };
        }

        let unitsDelta = type === 'deposit'
            ? amount / navPerUnitBefore
            : -(amount / navPerUnitBefore);
        if (type === 'withdrawal') {
            unitsDelta = -Math.min(userUnitsBefore, Math.abs(unitsDelta));
        }
        unitsDelta = +unitsDelta.toFixed(8);

        const newCash = +(type === 'deposit' ? userCash - amount : userCash + amount).toFixed(2);
        await client.query('UPDATE users SET cash = $1 WHERE id = $2', [newCash, req.user.id]);

        const fundCapitalAfter = +(type === 'deposit' ? fundCapitalBefore + amount : fundCapitalBefore - amount).toFixed(2);
        const fundUnitsAfterRaw = fundUnitsBefore + unitsDelta;
        const fundUnitsAfter = Math.abs(fundUnitsAfterRaw) < 1e-8 ? 0 : +fundUnitsAfterRaw.toFixed(8);
        const navAfter = +(fundCapitalAfter + fundPnl).toFixed(2);
        const navPerUnitAfter = +getSafeNavPerUnit(navAfter, fundUnitsAfter).toFixed(8);

        const insertResult = await client.query(
            `
            INSERT INTO fund_capital (
                id, fund_id, user_id, amount, type, units_delta, nav_per_unit, nav_before, nav_after, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
            `,
            [capitalId, req.params.id, req.user.id, amount, type, unitsDelta, navPerUnitBefore, navBefore, navAfter, now]
        );

        await client.query(
            `
            INSERT INTO fund_nav_snapshots (fund_id, nav, nav_per_unit, total_units, capital, pnl, snapshot_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [req.params.id, navAfter, navPerUnitAfter, fundUnitsAfter, fundCapitalAfter, fundPnl, now]
        );

        const newUserCapital = +(type === 'deposit' ? userCapital + amount : userCapital - amount).toFixed(2);
        const newUserUnits = +(userUnitsBefore + unitsDelta).toFixed(8);
        const newUserValue = +(newUserUnits * navPerUnitAfter).toFixed(2);
        return {
            transaction: insertResult.rows[0],
            cash: newCash,
            userCapital: newUserCapital,
            userUnits: newUserUnits,
            userValue: newUserValue,
            navPerUnit: navPerUnitAfter,
            nav: navAfter,
        };
    });

    if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
    }

    res.status(201).json({
        success: true,
        transaction: result.transaction,
        cash: result.cash,
        userCapital: result.userCapital,
        userUnits: result.userUnits,
        userValue: result.userValue,
        navPerUnit: result.navPerUnit,
        nav: result.nav,
    });
}));

// Get capital transactions (analyst/owner only)
router.get('/funds/:id/capital', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const transactions = await stmts.getFundCapitalTransactions.all(req.params.id);
    res.json(transactions);
}));

// Get capital summary by user (analyst/owner only)
router.get('/funds/:id/capital/summary', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const summary = await stmts.getFundCapitalSummary.all(req.params.id, 'deposit');
    res.json(summary);
}));

// NAV details (fund members only)
router.get('/funds/:id/nav', authenticate, requireFundMember, asyncRoute(async (req, res) => {
    const fundId = req.params.id;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 120, 1), 500);

    const [navState, snapshotsRaw, userLedger] = await Promise.all([
        getFundNavState(fundId),
        stmts.getFundNavSnapshots.all(fundId, limit),
        getUserFundLedgerState(fundId, req.user.id),
    ]);

    const userUnits = toNum(userLedger?.totalUnits, 0);
    const userCapital = toNum(userLedger?.netCapital, 0);
    const userValue = +(userUnits * navState.navPerUnit).toFixed(2);
    const userOwnershipPct = navState.totalUnits > 0
        ? +((userUnits / navState.totalUnits) * 100).toFixed(4)
        : 0;

    const snapshots = snapshotsRaw
        .slice()
        .reverse()
        .map(s => ({
            snapshotAt: s.snapshot_at,
            nav: +toNum(s.nav, 0).toFixed(2),
            navPerUnit: +toNum(s.nav_per_unit, 1).toFixed(8),
            totalUnits: +toNum(s.total_units, 0).toFixed(8),
            capital: +toNum(s.capital, 0).toFixed(2),
            pnl: +toNum(s.pnl, 0).toFixed(2),
        }));

    const latestSnapshotAt = snapshots.length ? snapshots[snapshots.length - 1].snapshotAt : 0;
    if (!latestSnapshotAt || Date.now() - latestSnapshotAt > 60_000) {
        snapshots.push({
            snapshotAt: Date.now(),
            nav: navState.nav,
            navPerUnit: navState.navPerUnit,
            totalUnits: navState.totalUnits,
            capital: navState.capital,
            pnl: navState.pnl,
        });
    }

    const asOf = Date.now();
    res.json({
        fundId,
        asOf,
        as_of: asOf,
        nav: navState.nav,
        navPerUnit: navState.navPerUnit,
        totalUnits: navState.totalUnits,
        capital: navState.capital,
        pnl: navState.pnl,
        dailyDrawdownPct: navState.dailyDrawdownPct,
        user: {
            userId: req.user.id,
            units: +userUnits.toFixed(8),
            netCapital: +userCapital.toFixed(2),
            value: userValue,
            ownershipPct: userOwnershipPct,
            pnl: +(userValue - userCapital).toFixed(2),
        },
        snapshots,
        calculation_basis: {
            nav: 'capital_plus_strategy_pnl',
            nav_per_unit: 'nav_over_total_units_with_safe_floor',
            user_value: 'user_units_x_nav_per_unit',
        },
    });
}));

// Investor unit ledger (analyst/owner only)
router.get('/funds/:id/investors', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const fundId = req.params.id;
    const [navState, capitalTxRaw] = await Promise.all([
        getFundNavState(fundId),
        stmts.getFundCapitalTransactions.all(fundId),
    ]);

    const capitalTx = normalizeCapitalTransactions(capitalTxRaw);
    const investors = buildInvestorLedgerFromTransactions(capitalTx, navState.navPerUnit, navState.totalUnits);

    const asOf = Date.now();
    res.json({
        fundId,
        asOf,
        as_of: asOf,
        nav: navState.nav,
        navPerUnit: navState.navPerUnit,
        totalUnits: navState.totalUnits,
        investors,
        calculation_basis: {
            investor_value: 'investor_units_x_nav_per_unit',
            investor_ownership: 'investor_units_over_total_units',
        },
    });
}));

// Fund reconciliation checks (analyst/owner only)
router.get('/funds/:id/reconciliation', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const fundId = req.params.id;
    const [navState, capitalTxRaw, snapshotsRaw] = await Promise.all([
        getFundNavState(fundId),
        stmts.getFundCapitalTransactions.all(fundId),
        stmts.getFundNavSnapshots.all(fundId, 1),
    ]);

    const capitalTx = normalizeCapitalTransactions(capitalTxRaw);
    const snapshots = normalizeNavSnapshots(snapshotsRaw);
    const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;

    const netCapitalByTx = round2(sumNetCapital(capitalTx));
    const totalUnitsByTx = round8(sumUnits(capitalTx));
    const navByUnits = round2(totalUnitsByTx * navState.navPerUnit);

    const investors = buildInvestorLedgerFromTransactions(capitalTx, navState.navPerUnit, navState.totalUnits)
        .map((row) => ({
            user_id: row.user_id,
            username: row.username,
            units: round8(Number(row.units || 0)),
            net_capital: round2(Number(row.netCapital || 0)),
            value: round2(Number(row.value || 0)),
        }));
    const investorValueTotal = round2(investors.reduce((sum, row) => sum + row.value, 0));

    const checks = computeReconciliation({
        nav: navState.nav,
        capital: navState.capital,
        pnl: navState.pnl,
        fees: 0,
        investorValue: investorValueTotal,
        unitsValue: navByUnits,
        tolerance: 0.01,
    });

    res.json({
        fundId,
        as_of: Number(latestSnapshot?.snapshotAt || Date.now()),
        nav: round2(navState.nav),
        navPerUnit: round8(navState.navPerUnit),
        capital: round2(navState.capital),
        pnl: round2(navState.pnl),
        netCapitalByTransactions: netCapitalByTx,
        totalUnitsByTransactions: totalUnitsByTx,
        navByUnits,
        investorValueTotal,
        investors,
        checks,
        calculation_basis: {
            nav_formula: 'capital_plus_pnl_minus_fees_assumed_zero',
            nav_units_check: 'total_units_x_nav_per_unit',
            investor_ledger_check: 'sum_investor_value_equals_nav',
        },
    });
}));

// ============================================================
// FUND RISK ENDPOINTS
// ============================================================

// Get risk settings + utilization snapshot (analyst/owner only)
router.get('/funds/:id/risk', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const [settingsRow, snapshot, breaches] = await Promise.all([
        stmts.getFundRiskSettings.get(req.params.id),
        strategyRunner.getFundRiskSnapshot(req.params.id),
        stmts.getFundRiskBreaches.all(req.params.id, 25),
    ]);

    const settings = strategyRunner.normalizeRiskSettings(settingsRow || strategyRunner.FUND_RISK_DEFAULTS);
    res.json({
        settings,
        utilization: snapshot,
        breaches,
    });
}));

// Update risk settings (owner only)
router.put('/funds/:id/risk', authenticate, requireFundOwner, asyncRoute(async (req, res) => {
    const current = strategyRunner.normalizeRiskSettings(
        await stmts.getFundRiskSettings.get(req.params.id) || strategyRunner.FUND_RISK_DEFAULTS
    );
    const nextSettings = normalizeRiskSettingsPayload(req.body || {}, current);
    const now = Date.now();

    await stmts.upsertFundRiskSettings.run(
        req.params.id,
        nextSettings.max_position_pct,
        nextSettings.max_strategy_allocation_pct,
        nextSettings.max_daily_drawdown_pct,
        nextSettings.is_enabled,
        req.user.id,
        now
    );

    const [settingsRow, snapshot] = await Promise.all([
        stmts.getFundRiskSettings.get(req.params.id),
        strategyRunner.getFundRiskSnapshot(req.params.id),
    ]);
    const settings = strategyRunner.normalizeRiskSettings(settingsRow || nextSettings);
    res.json({ success: true, settings, utilization: snapshot });
}));

// Get risk breaches (analyst/owner only)
router.get('/funds/:id/risk/breaches', authenticate, requireFundAnalyst, asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const breaches = await stmts.getFundRiskBreaches.all(req.params.id, limit);
    res.json(breaches);
}));

// ============================================================
// STRATEGY ENDPOINTS
// ============================================================

// List strategies for a fund (fund members only)
router.get('/funds/:fundId/strategies', authenticate, asyncRoute(async (req, res) => {
    const { fundId } = req.params;
    const membership = await stmts.getFundMember.get(fundId, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }
    const strategies = (await stmts.getStrategiesByFund.all(fundId))
        .filter((strategy) => strategy.type !== 'custom');
    const enriched = await Promise.all(strategies.map(async (strategy) => {
        const latest = await stmts.getLatestStrategyBacktest.get(strategy.id);
        return {
            ...strategy,
            latest_backtest: summarizeBacktestRecord(latest),
        };
    }));
    res.json(enriched);
}));

// Create a new strategy (fund members only)
router.post('/funds/:fundId/strategies', authenticate, asyncRoute(async (req, res) => {
    const { fundId } = req.params;
    const { name, type, config } = req.body;

    const membership = await stmts.getFundMember.get(fundId, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    if (!name || !type) {
        return res.status(400).json({ error: 'Missing required fields: name, type' });
    }

    const validTypes = ['mean_reversion', 'momentum', 'grid', 'pairs', 'custom'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be: ${validTypes.join(', ')}` });
    }

    const strategyId = uuid();
    const now = Date.now();

    await stmts.insertStrategy.run(
        strategyId,
        fundId,
        name,
        type,
        JSON.stringify(config || {}),
        false,
        now,
        now
    );

    const strategy = await stmts.getStrategyById.get(strategyId);
    res.status(201).json({ success: true, strategy });
}));

// Get a single strategy by ID (fund members only)
router.get('/strategies/:id', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const latest = await stmts.getLatestStrategyBacktest.get(strategy.id);
    res.json({
        ...strategy,
        latest_backtest: summarizeBacktestRecord(latest),
    });
}));

// Fund dashboard — live PnL, trades, positions, signals
router.get('/funds/:fundId/dashboard', authenticate, asyncRoute(async (req, res) => {
    const { fundId } = req.params;

    const membership = await stmts.getFundMember.get(fundId, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const strategies = await stmts.getStrategiesByFund.all(fundId);
    const dashboard = strategyRunner.getDashboardData(fundId, strategies);
    const summary = dashboard?.summary || {};
    res.json({
        ...dashboard,
        summary: {
            ...summary,
            gross_pnl: Number(summary.grossPnl || 0),
            net_pnl: Number(summary.netPnl || 0),
            total_slippage_cost: Number(summary.totalSlippageCost || 0),
            total_commission: Number(summary.totalCommission || 0),
            total_borrow_cost: Number(summary.totalBorrowCost || 0),
            total_execution_cost: Number(summary.totalExecutionCost || 0),
            cost_drag_pct: Number(summary.executionDragPct || 0),
        },
        as_of: Date.now(),
        calculation_basis: {
            fills: 'count_of_strategy_trade_executions',
            closed_trades: 'wins_plus_losses_plus_breakevens',
            non_closing_fills: 'fills_minus_closed_trades',
            win_rate: 'wins_over_resolved_trades',
            gross_pnl: 'net_pnl_plus_execution_costs',
        },
    });
}));

// Strategy trades
router.get('/strategies/:id/trades', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const trades = await stmts.getStrategyTrades.all(strategy.id, 100);
    res.json(trades);
}));

// Run strategy backtest (fund members only)
router.post('/strategies/:id/backtest', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const bars = Math.min(Math.max(Number.parseInt(req.body?.bars, 10) || 500, 100), 2000);
    const thresholds = req.body?.thresholds || {};

    let result;
    try {
        result = await backtester.runStrategyBacktest(strategy, { bars, thresholds });
    } catch (error) {
        return res.status(400).json({ error: error.message || 'Backtest failed' });
    }
    const rowId = uuid();
    const now = Date.now();

    await stmts.insertStrategyBacktest.run(
        rowId,
        strategy.id,
        strategy.fund_id,
        result.configHash,
        JSON.stringify(result.configSnapshot || {}),
        JSON.stringify(result.metrics || {}),
        JSON.stringify(result.thresholds || {}),
        result.passed,
        result.notes,
        now
    );

    const saved = await stmts.getLatestStrategyBacktest.get(strategy.id);
    res.status(201).json({ success: true, backtest: summarizeBacktestRecord(saved), failures: result.failures || [] });
}));

// List backtests for a strategy (fund members only)
router.get('/strategies/:id/backtests', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 200);
    const rows = await stmts.getStrategyBacktests.all(strategy.id, limit);
    res.json(rows.map((row) => summarizeBacktestRecord(row)));
}));

// Update a strategy (fund members only)
router.put('/strategies/:id', authenticate, asyncRoute(async (req, res) => {
    const { name, type, config } = req.body;

    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    if (type) {
        const validTypes = ['mean_reversion', 'momentum', 'grid', 'pairs', 'custom'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: `Invalid type. Must be: ${validTypes.join(', ')}` });
        }
    }

    const now = Date.now();
    await stmts.updateStrategy.run(
        name || strategy.name,
        type || strategy.type,
        JSON.stringify(config !== undefined ? config : strategy.config),
        strategy.is_active,
        now,
        req.params.id
    );

    const updated = await stmts.getStrategyById.get(req.params.id);
    res.json({ success: true, strategy: updated });
}));

// Delete a strategy (fund members only)
router.delete('/strategies/:id', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    await stmts.deleteStrategyBacktests.run(req.params.id);
    await stmts.deleteStrategy.run(req.params.id);
    res.json({ success: true });
}));

// Start a strategy (fund members only)
router.post('/strategies/:id/start', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    if (strategy.is_active) {
        return res.status(400).json({ error: 'Strategy is already active' });
    }

    if (strategy.type !== 'custom') {
        const latest = await stmts.getLatestStrategyBacktest.get(strategy.id);
        if (!latest) {
            return res.status(400).json({ error: 'Backtest required before deploy. Run a backtest first.' });
        }

        const latestSummary = summarizeBacktestRecord(latest);
        if (!latestSummary.passed) {
            return res.status(400).json({ error: `Deploy blocked: latest backtest failed gate (${latestSummary.notes || 'thresholds not met'}).` });
        }

        const config = backtester.normalizeStrategyConfig(strategy);
        const currentHash = backtester.computeConfigHash(config);
        if (latestSummary.config_hash !== currentHash) {
            return res.status(400).json({ error: 'Deploy blocked: strategy config changed since last passing backtest. Re-run backtest.' });
        }
    }

    const now = Date.now();
    await stmts.updateStrategy.run(
        strategy.name,
        strategy.type,
        JSON.stringify(strategy.config),
        true,
        now,
        req.params.id
    );

    const updated = await stmts.getStrategyById.get(req.params.id);
    res.json({ success: true, strategy: updated });
}));

// Stop a strategy (fund members only)
router.post('/strategies/:id/stop', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    if (!strategy.is_active) {
        return res.status(400).json({ error: 'Strategy is already stopped' });
    }

    const now = Date.now();
    await stmts.updateStrategy.run(
        strategy.name,
        strategy.type,
        JSON.stringify(strategy.config),
        false,
        now,
        req.params.id
    );

    const updated = await stmts.getStrategyById.get(req.params.id);
    res.json({ success: true, strategy: updated });
}));

// ============================================================
// CUSTOM STRATEGY ENDPOINTS
// ============================================================

function parseJsonObject(value, fallback = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            return fallback;
        }
    }
    return fallback;
}

function buildCustomStrategyShadowConfig(strategyId, parameters) {
    return {
        customStrategyId: strategyId,
        parameters: parseJsonObject(parameters, {}),
    };
}

// Validate that code looks like a function
function validateStrategyCode(code) {
    if (typeof code !== 'string' || code.trim().length === 0) {
        return { valid: false, error: 'Code must be a non-empty string' };
    }
    // Simple check: must contain function keyword or arrow syntax
    if (!code.includes('function') && !code.includes('=>')) {
        return { valid: false, error: 'Code must be a function (use "function" or arrow syntax)' };
    }
    return { valid: true };
}

// Create a custom strategy (fund owner only)
router.post('/custom-strategies', authenticate, asyncRoute(async (req, res) => {
    const { fund_id, name, code, parameters } = req.body;

    if (!fund_id || !name || !code) {
        return res.status(400).json({ error: 'Missing required fields: fund_id, name, code' });
    }

    // Verify fund ownership
    const membership = await stmts.getFundMember.get(fund_id, req.user.id);
    if (!membership || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Owner access required for this fund' });
    }

    // Validate code
    const validation = validateStrategyCode(code);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }

    const strategyId = uuid();
    const now = Date.now();

    const normalizedParams = parseJsonObject(parameters, {});
    await runInTransaction('create_custom_strategy', async (client) => {
        await client.query(
            'INSERT INTO custom_strategies (id, fund_id, name, code, parameters, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [strategyId, fund_id, name, code, JSON.stringify(normalizedParams), true, now, now]
        );
        await client.query(
            'INSERT INTO strategies (id, fund_id, name, type, config, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [strategyId, fund_id, name, 'custom', JSON.stringify(buildCustomStrategyShadowConfig(strategyId, normalizedParams)), true, now, now]
        );
    });

    const strategy = await stmts.getCustomStrategyById.get(strategyId);
    res.status(201).json({ success: true, strategy });
}));

// Get a custom strategy by ID (fund members only)
router.get('/custom-strategies/:id', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getCustomStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Custom strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    res.json(strategy);
}));

// List custom strategies for a fund (fund members only)
router.get('/funds/:fundId/custom-strategies', authenticate, asyncRoute(async (req, res) => {
    const { fundId } = req.params;

    const membership = await stmts.getFundMember.get(fundId, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const strategies = await stmts.getCustomStrategiesByFund.all(fundId);
    res.json(strategies);
}));

// Update a custom strategy (fund owner only)
router.put('/custom-strategies/:id', authenticate, asyncRoute(async (req, res) => {
    const { name, code, parameters, is_active } = req.body;

    const strategy = await stmts.getCustomStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Custom strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!membership || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Owner access required for this fund' });
    }

    // Validate code if provided
    if (code !== undefined) {
        const validation = validateStrategyCode(code);
        if (!validation.valid) {
            return res.status(400).json({ error: validation.error });
        }
    }

    const now = Date.now();
    const nextName = name || strategy.name;
    const nextCode = code !== undefined ? code : strategy.code;
    const nextParams = parseJsonObject(parameters !== undefined ? parameters : strategy.parameters, {});
    const nextIsActive = is_active !== undefined ? is_active : strategy.is_active;

    await stmts.updateCustomStrategy.run(
        nextName,
        nextCode,
        JSON.stringify(nextParams),
        nextIsActive,
        now,
        req.params.id
    );

    const existingShadow = await stmts.getStrategyById.get(req.params.id);
    if (existingShadow) {
        await stmts.updateStrategy.run(
            nextName,
            'custom',
            JSON.stringify(buildCustomStrategyShadowConfig(req.params.id, nextParams)),
            nextIsActive,
            now,
            req.params.id
        );
    } else {
        await stmts.insertStrategy.run(
            req.params.id,
            strategy.fund_id,
            nextName,
            'custom',
            JSON.stringify(buildCustomStrategyShadowConfig(req.params.id, nextParams)),
            nextIsActive,
            Number(strategy.created_at) || now,
            now
        );
    }

    const updated = await stmts.getCustomStrategyById.get(req.params.id);
    res.json({ success: true, strategy: updated });
}));

// Delete a custom strategy (fund owner only)
router.delete('/custom-strategies/:id', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getCustomStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Custom strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!membership || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Owner access required for this fund' });
    }

    await runInTransaction('delete_custom_strategy', async (client) => {
        await client.query('DELETE FROM strategy_trades WHERE strategy_id = $1', [req.params.id]);
        await client.query('DELETE FROM strategy_backtests WHERE strategy_id = $1', [req.params.id]);
        await client.query('DELETE FROM strategies WHERE id = $1', [req.params.id]);
        await client.query('DELETE FROM custom_strategies WHERE id = $1', [req.params.id]);
    });
    res.json({ success: true });
}));

// Test run a custom strategy (fund members only, no trades executed)
router.post('/custom-strategies/:id/test', authenticate, asyncRoute(async (req, res) => {
    const strategy = await stmts.getCustomStrategyById.get(req.params.id);
    if (!strategy) {
        return res.status(404).json({ error: 'Custom strategy not found' });
    }

    const membership = await stmts.getFundMember.get(strategy.fund_id, req.user.id);
    if (!hasFundManagerAccess(membership)) {
        return res.status(403).json({ error: 'Analyst or owner access required' });
    }

    const { test_data } = req.body;

    try {
        // Create a sandboxed execution context
        const sandboxContext = {
            prices: engine.getAllPrices(),
            candles: {},
            ticker: (symbol) => engine.getPrice(symbol?.toUpperCase()),
            getPrice: (symbol) => engine.getPrice(symbol?.toUpperCase()),
            state: {},
            parameters: parseJsonObject(strategy.parameters, {}),
            log: (...args) => console.log('[Strategy Test]', ...args),
        };

        // Build and execute the strategy function
        // Note: This is a simple test runner. In production, you'd want a proper sandbox.
        const fn = new Function('context', `
            const { prices, candles, ticker, getPrice, state, parameters, log } = context;
            ${strategy.code}
            return typeof run === 'function' ? run(context) : (typeof strategy === 'function' ? strategy(context) : null);
        `);

        const testResult = fn(sandboxContext);

        res.json({
            success: true,
            result: testResult,
            message: 'Strategy executed in test mode (no trades placed)',
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message,
            message: 'Strategy execution failed',
        });
    }
}));

// ============================================================
// ADMIN ENDPOINTS
// ============================================================

router.post('/admin/reset-portfolios', authenticate, asyncRoute(async (req, res) => {
    // Check admin role from DB
    const user = await stmts.getUserById.get(req.user.id);
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    // Reset all portfolio data
    await stmts.resetAllPositions.run();
    await stmts.resetAllTrades.run();
    await stmts.resetAllOrders.run();
    await stmts.resetAllSnapshots.run();
    await stmts.resetAllUserCash.run();

    res.json({ success: true, message: 'All portfolios have been reset' });
}));

router.use('/client-portal', clientPortal);

module.exports = router;
