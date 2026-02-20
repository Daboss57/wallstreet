const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError } = require('./db');
const engine = require('./engine');
const { meanReversionStrategy } = require('./strategies/meanReversion');
const { momentumStrategy } = require('./strategies/momentum');
const gridStrategy = require('./strategies/grid');
const pairsStrategy = require('./strategies/pairs');

// ─── In-memory state ────────────────────────────────────────────────────────
const strategyStates = new Map(); // strategyId → { trades, pnl, positions, signals }
let runnerInterval = null;
let paused = false;
let lastRunAt = 0;
let totalRuns = 0;

const RUN_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MEMORY_TRADES = 200;  // per strategy

function getOrCreateState(strategyId) {
    if (!strategyStates.has(strategyId)) {
        strategyStates.set(strategyId, {
            trades: [],
            positions: {},    // ticker → { qty, avgEntry, side }
            realizedPnl: 0,
            signals: [],      // last 50 signals for activity log
            tradeCount: 0,
            winCount: 0,
            lossCount: 0,
            lastSignal: null,
            lastRunAt: 0,
        });
    }
    return strategyStates.get(strategyId);
}

// ─── Execute a single strategy ──────────────────────────────────────────────
async function executeStrategy(strategy) {
    const config = typeof strategy.config === 'string'
        ? JSON.parse(strategy.config)
        : (strategy.config || {});

    const state = getOrCreateState(strategy.id);
    let result;

    try {
        switch (strategy.type) {
            case 'mean_reversion':
                result = await meanReversionStrategy({
                    ticker: config.ticker,
                    period: config.period || 20,
                    stdDevMultiplier: config.stdDevMultiplier || 2,
                    positionSize: config.positionSize || 10,
                    interval: config.interval || '5m',
                });
                break;

            case 'momentum':
                result = await momentumStrategy({
                    ticker: config.ticker,
                    period: config.period || 14,
                    positionSize: config.positionSize || 10,
                    interval: config.interval || '5m',
                });
                break;

            case 'grid':
                result = await gridStrategy.execute(strategy.fund_id, {
                    ticker: config.ticker,
                    gridSpacing: config.gridSpacing || 1,
                    gridLevels: config.gridLevels || 5,
                    positionSize: config.positionSize || 10,
                    interval: config.interval || '5m',
                });
                break;

            case 'pairs':
                result = await pairsStrategy.execute(strategy.fund_id, {
                    tickerA: config.ticker,
                    tickerB: config.ticker2,
                    lookback: config.lookback || 20,
                    stdDevThreshold: config.stdDevThreshold || 2,
                    positionSize: config.positionSize || 10,
                    interval: config.interval || '5m',
                });
                break;

            default:
                return;
        }
    } catch (err) {
        console.error(`[StrategyRunner] Error executing ${strategy.name}:`, err.message);
        return;
    }

    if (!result) return;

    // Normalize signal
    const signal = (result.signal || result.action || 'hold').toLowerCase();
    const ticker = result.ticker || config.ticker;
    const qty = result.positionSize || result.quantity || 10;

    // Record signal in activity log
    state.signals.unshift({
        signal,
        ticker,
        reason: result.reason || '',
        timestamp: Date.now(),
        data: result.data || {},
    });
    if (state.signals.length > 50) state.signals.length = 50;
    state.lastSignal = signal;
    state.lastRunAt = Date.now();

    // Only record trades on buy/sell
    if (signal === 'hold') return;

    const priceData = engine.getPrice(ticker);
    if (!priceData) return;

    const price = signal === 'buy' ? priceData.ask : priceData.bid;
    const side = signal;
    const now = Date.now();
    const tradeId = uuid();

    // Record to DB
    try {
        await stmts.insertStrategyTrade.run(
            tradeId, strategy.id, ticker, side, qty, price, now
        );
    } catch (err) {
        if (!isDbUnavailableError(err)) {
            console.error(`[StrategyRunner] DB trade insert error:`, err.message);
        }
        return;
    }

    // Update in-memory state
    const trade = { id: tradeId, ticker, side, quantity: qty, price, executed_at: now, strategy_name: strategy.name };
    state.trades.unshift(trade);
    if (state.trades.length > MAX_MEMORY_TRADES) state.trades.length = MAX_MEMORY_TRADES;
    state.tradeCount++;

    // Update positions
    updatePosition(state, ticker, side, qty, price);
}

// ─── Position tracking ──────────────────────────────────────────────────────
function updatePosition(state, ticker, side, qty, price) {
    const pos = state.positions[ticker] || { qty: 0, avgEntry: 0, side: 'flat', totalCost: 0 };

    if (side === 'buy') {
        if (pos.qty < 0) {
            // Closing a short
            const closedQty = Math.min(qty, Math.abs(pos.qty));
            const pnl = closedQty * (pos.avgEntry - price);
            state.realizedPnl += pnl;
            if (pnl > 0) state.winCount++; else state.lossCount++;
            pos.qty += closedQty;
            const remaining = qty - closedQty;
            if (remaining > 0) {
                pos.qty = remaining;
                pos.avgEntry = price;
                pos.side = 'long';
                pos.totalCost = remaining * price;
            } else if (pos.qty === 0) {
                pos.side = 'flat';
                pos.avgEntry = 0;
                pos.totalCost = 0;
            }
        } else {
            // Adding to long
            pos.totalCost = (pos.totalCost || pos.avgEntry * pos.qty) + qty * price;
            pos.qty += qty;
            pos.avgEntry = pos.totalCost / pos.qty;
            pos.side = 'long';
        }
    } else {
        // sell
        if (pos.qty > 0) {
            // Closing a long
            const closedQty = Math.min(qty, pos.qty);
            const pnl = closedQty * (price - pos.avgEntry);
            state.realizedPnl += pnl;
            if (pnl > 0) state.winCount++; else state.lossCount++;
            pos.qty -= closedQty;
            const remaining = qty - closedQty;
            if (remaining > 0) {
                pos.qty = -remaining;
                pos.avgEntry = price;
                pos.side = 'short';
                pos.totalCost = remaining * price;
            } else if (pos.qty === 0) {
                pos.side = 'flat';
                pos.avgEntry = 0;
                pos.totalCost = 0;
            }
        } else {
            // Adding to short
            pos.totalCost = (pos.totalCost || Math.abs(pos.qty) * pos.avgEntry) + qty * price;
            pos.qty -= qty;
            pos.avgEntry = pos.totalCost / Math.abs(pos.qty);
            pos.side = 'short';
        }
    }

    state.positions[ticker] = pos;
}

// ─── Main run loop ──────────────────────────────────────────────────────────
async function runAll() {
    if (paused) return;

    try {
        const strategies = await stmts.getActiveStrategiesAll.all();
        if (!strategies || strategies.length === 0) return;

        for (const strategy of strategies) {
            try {
                await executeStrategy(strategy);
            } catch (err) {
                console.error(`[StrategyRunner] Strategy ${strategy.id} failed:`, err.message);
            }
        }

        totalRuns++;
        lastRunAt = Date.now();
    } catch (err) {
        if (!isDbUnavailableError(err)) {
            console.error('[StrategyRunner] Run loop error:', err.message);
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────
function start() {
    if (runnerInterval) return;
    runnerInterval = setInterval(runAll, RUN_INTERVAL_MS);
    console.log(`[StrategyRunner] Running — ${RUN_INTERVAL_MS / 1000}s interval`);
    // First run after a short delay to let engine populate candles
    setTimeout(runAll, 5000);
}

function stop() {
    if (runnerInterval) {
        clearInterval(runnerInterval);
        runnerInterval = null;
    }
    console.log('[StrategyRunner] Stopped');
}

function setPaused(value) {
    paused = value;
}

/**
 * Get dashboard data for a specific fund
 */
function getDashboardData(fundId, strategies) {
    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;
    const allTrades = [];
    const allPositions = [];
    const allSignals = [];
    const perStrategy = [];

    for (const s of strategies) {
        const state = strategyStates.get(s.id);
        if (!state) {
            perStrategy.push({
                id: s.id, name: s.name, type: s.type, is_active: s.is_active,
                tradeCount: 0, winCount: 0, lossCount: 0, realizedPnl: 0,
                unrealizedPnl: 0, lastSignal: null, lastRunAt: 0,
            });
            continue;
        }

        // Calculate unrealized PnL
        let stratUnrealized = 0;
        for (const [ticker, pos] of Object.entries(state.positions)) {
            if (pos.qty === 0) continue;
            const priceData = engine.getPrice(ticker);
            if (!priceData) continue;
            const currentPrice = priceData.price;
            if (pos.side === 'long') {
                const uPnl = pos.qty * (currentPrice - pos.avgEntry);
                stratUnrealized += uPnl;
                allPositions.push({ ticker, qty: pos.qty, side: pos.side, avgEntry: pos.avgEntry, currentPrice, unrealizedPnl: uPnl, strategyName: s.name });
            } else if (pos.side === 'short') {
                const uPnl = Math.abs(pos.qty) * (pos.avgEntry - currentPrice);
                stratUnrealized += uPnl;
                allPositions.push({ ticker, qty: pos.qty, side: pos.side, avgEntry: pos.avgEntry, currentPrice, unrealizedPnl: uPnl, strategyName: s.name });
            }
        }

        totalRealized += state.realizedPnl;
        totalUnrealized += stratUnrealized;
        totalTrades += state.tradeCount;
        totalWins += state.winCount;
        totalLosses += state.lossCount;

        // Collect trades
        for (const t of state.trades) {
            allTrades.push({ ...t, strategy_name: s.name, strategy_type: s.type });
        }

        // Collect signals
        for (const sig of state.signals.slice(0, 10)) {
            allSignals.push({ ...sig, strategy_name: s.name, strategy_type: s.type });
        }

        perStrategy.push({
            id: s.id, name: s.name, type: s.type, is_active: s.is_active,
            tradeCount: state.tradeCount,
            winCount: state.winCount,
            lossCount: state.lossCount,
            realizedPnl: state.realizedPnl,
            unrealizedPnl: stratUnrealized,
            lastSignal: state.lastSignal,
            lastRunAt: state.lastRunAt,
        });
    }

    // Sort trades/signals by time
    allTrades.sort((a, b) => b.executed_at - a.executed_at);
    allSignals.sort((a, b) => b.timestamp - a.timestamp);

    const winRate = totalTrades > 0 ? ((totalWins / (totalWins + totalLosses)) * 100) : 0;

    return {
        summary: {
            totalPnl: totalRealized + totalUnrealized,
            realizedPnl: totalRealized,
            unrealizedPnl: totalUnrealized,
            totalTrades,
            winRate: +winRate.toFixed(1),
            wins: totalWins,
            losses: totalLosses,
        },
        trades: allTrades.slice(0, 50),
        positions: allPositions,
        signals: allSignals.slice(0, 30),
        strategies: perStrategy,
        meta: {
            lastRunAt,
            totalRuns,
            runIntervalMs: RUN_INTERVAL_MS,
            isPaused: paused,
        },
    };
}

module.exports = { start, stop, setPaused, getDashboardData, runAll };
