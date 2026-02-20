const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError } = require('./db');
const engine = require('./engine');
const { meanReversionStrategy } = require('./strategies/meanReversion');
const { momentumStrategy } = require('./strategies/momentum');
const gridStrategy = require('./strategies/grid');
const pairsStrategy = require('./strategies/pairs');

// ─── In-memory state ────────────────────────────────────────────────────────
const strategyStates = new Map(); // strategyId → { trades, pnl, positions, signals }
const strategyFundMap = new Map(); // strategyId -> fundId
const fundRiskDayState = new Map(); // fundId -> { dateKey, peakEquity }
let runnerInterval = null;
let paused = false;
let lastRunAt = 0;
let totalRuns = 0;

const RUN_INTERVAL_MS = 30_000; // 30 seconds
const MAX_MEMORY_TRADES = 200;  // per strategy
const FUND_RISK_DEFAULTS = {
    max_position_pct: 25,
    max_strategy_allocation_pct: 50,
    max_daily_drawdown_pct: 8,
    is_enabled: true,
};

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function toPositiveNumber(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function normalizeRiskSettings(settings = {}) {
    return {
        max_position_pct: clampNumber(settings.max_position_pct, FUND_RISK_DEFAULTS.max_position_pct, 1, 100),
        max_strategy_allocation_pct: clampNumber(settings.max_strategy_allocation_pct, FUND_RISK_DEFAULTS.max_strategy_allocation_pct, 1, 100),
        max_daily_drawdown_pct: clampNumber(settings.max_daily_drawdown_pct, FUND_RISK_DEFAULTS.max_daily_drawdown_pct, 0.1, 100),
        is_enabled: settings.is_enabled === undefined ? FUND_RISK_DEFAULTS.is_enabled : Boolean(settings.is_enabled),
        updated_at: settings.updated_at || null,
        updated_by: settings.updated_by || null,
    };
}

async function getFundRiskSettings(fundId) {
    const row = await stmts.getFundRiskSettings.get(fundId);
    return normalizeRiskSettings(row || {});
}

function getDateKey(timestamp = Date.now()) {
    const d = new Date(timestamp);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getExposureDelta(currentQty, side, qty, price) {
    const current = Number(currentQty) || 0;
    const tradeQty = Math.max(0, Number(qty) || 0);
    if (tradeQty <= 0 || !Number.isFinite(price) || price <= 0) return 0;
    const nextQty = side === 'buy' ? current + tradeQty : current - tradeQty;
    return (Math.abs(nextQty) - Math.abs(current)) * price;
}

function getFundExposureSnapshot(fundId) {
    let totalRealized = 0;
    let totalUnrealized = 0;
    let totalExposure = 0;
    const tickerExposure = new Map();
    const strategyExposure = new Map();

    for (const [strategyId, state] of strategyStates.entries()) {
        if (strategyFundMap.get(strategyId) !== fundId) continue;

        let strategyNotional = 0;
        let strategyUnrealized = 0;
        for (const [ticker, pos] of Object.entries(state.positions || {})) {
            if (!pos || !pos.qty) continue;
            const currentPrice = Number(engine.getPrice(ticker)?.price || pos.avgEntry || 0);
            if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

            const qty = Number(pos.qty) || 0;
            if (qty === 0) continue;

            const notional = Math.abs(qty) * currentPrice;
            strategyNotional += notional;
            totalExposure += notional;
            tickerExposure.set(ticker, (tickerExposure.get(ticker) || 0) + notional);

            const avgEntry = Number(pos.avgEntry) || 0;
            if (qty > 0) {
                strategyUnrealized += qty * (currentPrice - avgEntry);
            } else {
                strategyUnrealized += Math.abs(qty) * (avgEntry - currentPrice);
            }
        }

        strategyExposure.set(strategyId, strategyNotional);
        totalRealized += Number(state.realizedPnl || 0);
        totalUnrealized += strategyUnrealized;
    }

    return {
        totalExposure,
        tickerExposure,
        strategyExposure,
        totalRealized,
        totalUnrealized,
        totalPnl: totalRealized + totalUnrealized,
    };
}

function getDrawdownState(fundId, equity, timestamp = Date.now()) {
    const dateKey = getDateKey(timestamp);
    let dayState = fundRiskDayState.get(fundId);
    if (!dayState || dayState.dateKey !== dateKey) {
        dayState = { dateKey, peakEquity: equity };
    } else if (equity > dayState.peakEquity) {
        dayState.peakEquity = equity;
    }
    fundRiskDayState.set(fundId, dayState);

    const drawdownPct = dayState.peakEquity > 0
        ? Math.max(0, ((dayState.peakEquity - equity) / dayState.peakEquity) * 100)
        : 0;

    return {
        dateKey,
        peakEquity: dayState.peakEquity,
        drawdownPct,
    };
}

async function evaluateRiskGuards(strategy, state, side, ticker, qty, price) {
    const settings = await getFundRiskSettings(strategy.fund_id);
    if (!settings.is_enabled) return { allowed: true, settings };

    const netCapitalRow = await stmts.getFundNetCapital.get(strategy.fund_id);
    const fundCapital = Number(netCapitalRow?.net_capital || 0);
    if (!Number.isFinite(fundCapital) || fundCapital <= 0) {
        return {
            allowed: false,
            rule: 'fund_capital_required',
            message: 'Risk guard blocked trade: fund has no net capital.',
            context: { fundCapital, side, ticker, qty, price },
            settings,
        };
    }

    const snapshot = getFundExposureSnapshot(strategy.fund_id);
    const currentTickerExposure = snapshot.tickerExposure.get(ticker) || 0;
    const currentStrategyExposure = snapshot.strategyExposure.get(strategy.id) || 0;
    const currentTickerQty = Number(state.positions?.[ticker]?.qty || 0);
    const deltaExposure = getExposureDelta(currentTickerQty, side, qty, price);
    const projectedTickerExposure = Math.max(0, currentTickerExposure + deltaExposure);
    const projectedStrategyExposure = Math.max(0, currentStrategyExposure + deltaExposure);

    const projectedTickerPct = (projectedTickerExposure / fundCapital) * 100;
    if (projectedTickerPct > settings.max_position_pct + 1e-9) {
        return {
            allowed: false,
            rule: 'max_position_pct',
            message: `Risk guard blocked trade: projected ${ticker} exposure ${projectedTickerPct.toFixed(2)}% exceeds limit ${settings.max_position_pct.toFixed(2)}%.`,
            context: {
                fundCapital,
                currentTickerExposure,
                projectedTickerExposure,
                projectedTickerPct,
                limitPct: settings.max_position_pct,
                deltaExposure,
                side,
                ticker,
                qty,
                price,
            },
            settings,
        };
    }

    const projectedStrategyPct = (projectedStrategyExposure / fundCapital) * 100;
    if (projectedStrategyPct > settings.max_strategy_allocation_pct + 1e-9) {
        return {
            allowed: false,
            rule: 'max_strategy_allocation_pct',
            message: `Risk guard blocked trade: projected strategy exposure ${projectedStrategyPct.toFixed(2)}% exceeds limit ${settings.max_strategy_allocation_pct.toFixed(2)}%.`,
            context: {
                fundCapital,
                strategyId: strategy.id,
                currentStrategyExposure,
                projectedStrategyExposure,
                projectedStrategyPct,
                limitPct: settings.max_strategy_allocation_pct,
                deltaExposure,
                side,
                ticker,
                qty,
                price,
            },
            settings,
        };
    }

    const equity = fundCapital + snapshot.totalPnl;
    const drawdown = getDrawdownState(strategy.fund_id, equity);
    if (drawdown.drawdownPct > settings.max_daily_drawdown_pct + 1e-9) {
        return {
            allowed: false,
            rule: 'max_daily_drawdown_pct',
            message: `Risk guard blocked trade: current daily drawdown ${drawdown.drawdownPct.toFixed(2)}% exceeds limit ${settings.max_daily_drawdown_pct.toFixed(2)}%.`,
            context: {
                fundCapital,
                equity,
                peakEquity: drawdown.peakEquity,
                drawdownPct: drawdown.drawdownPct,
                limitPct: settings.max_daily_drawdown_pct,
                side,
                ticker,
                qty,
                price,
            },
            settings,
        };
    }

    return { allowed: true, settings };
}

async function recordRiskBreach(strategy, state, ticker, side, qty, price, breach) {
    const now = Date.now();
    state.signals.unshift({
        signal: 'blocked',
        ticker,
        reason: breach.message,
        timestamp: now,
        data: {
            rule: breach.rule,
            side,
            qty,
            price,
            context: breach.context || {},
        },
    });
    if (state.signals.length > 50) state.signals.length = 50;
    state.lastSignal = 'blocked';
    state.lastRunAt = now;

    try {
        await stmts.insertFundRiskBreach.run(
            uuid(),
            strategy.fund_id,
            strategy.id,
            breach.rule,
            'error',
            breach.message,
            JSON.stringify(breach.context || {}),
            JSON.stringify({ ticker, side, quantity: qty, price }),
            now
        );
    } catch (err) {
        if (!isDbUnavailableError(err)) {
            console.error('[StrategyRunner] Risk breach log error:', err.message);
        }
    }
}

async function getFundRiskSnapshot(fundId) {
    const settings = await getFundRiskSettings(fundId);
    const netCapitalRow = await stmts.getFundNetCapital.get(fundId);
    const fundCapital = Number(netCapitalRow?.net_capital || 0);
    const exposure = getFundExposureSnapshot(fundId);
    const equity = fundCapital + exposure.totalPnl;
    const drawdown = getDrawdownState(fundId, equity);

    const byTicker = Array.from(exposure.tickerExposure.entries())
        .map(([ticker, value]) => ({
            ticker,
            exposure: +value.toFixed(2),
            exposurePct: fundCapital > 0 ? +((value / fundCapital) * 100).toFixed(2) : 0,
        }))
        .sort((a, b) => b.exposure - a.exposure);

    const byStrategy = Array.from(exposure.strategyExposure.entries())
        .map(([strategyId, value]) => ({
            strategyId,
            exposure: +value.toFixed(2),
            exposurePct: fundCapital > 0 ? +((value / fundCapital) * 100).toFixed(2) : 0,
        }))
        .sort((a, b) => b.exposure - a.exposure);

    return {
        settings,
        capital: +fundCapital.toFixed(2),
        equity: +equity.toFixed(2),
        totalPnl: +exposure.totalPnl.toFixed(2),
        totalExposure: +exposure.totalExposure.toFixed(2),
        grossExposurePct: fundCapital > 0 ? +((exposure.totalExposure / fundCapital) * 100).toFixed(2) : 0,
        dailyDrawdownPct: +drawdown.drawdownPct.toFixed(2),
        dailyPeakEquity: +drawdown.peakEquity.toFixed(2),
        dateKey: drawdown.dateKey,
        byTicker,
        byStrategy,
    };
}

async function resolveStrategyTradeSizing(strategy, config, price) {
    const fixedNotional = toPositiveNumber(
        config?.fixedNotionalUsd
        ?? config?.notionalUsd
        ?? config?.targetNotionalUsd
        ?? config?.notional_usd
        ?? 0,
        0
    );

    let targetNotional = fixedNotional;
    let allocationPct = null;

    if (!targetNotional) {
        const allocationInput = Number(config?.allocationPct ?? config?.allocation_pct);
        allocationPct = Number.isFinite(allocationInput) && allocationInput > 0 ? allocationInput : 10;

        const snapshot = await getFundRiskSnapshot(strategy.fund_id);
        const fundEquity = toPositiveNumber(snapshot?.equity, 0);
        targetNotional = fundEquity * (allocationPct / 100);
    }

    if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
        targetNotional = price;
    }

    const qty = Math.max(1, Math.floor(targetNotional / price));
    const actualNotional = qty * price;
    return {
        qty,
        targetNotional: +targetNotional.toFixed(2),
        actualNotional: +actualNotional.toFixed(2),
        allocationPct: allocationPct !== null ? +allocationPct.toFixed(4) : null,
    };
}

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

function resetRuntimeState() {
    strategyStates.clear();
    strategyFundMap.clear();
    fundRiskDayState.clear();
    lastRunAt = 0;
    totalRuns = 0;
}

async function hydrateStateFromDb() {
    resetRuntimeState();

    const [strategies, trades] = await Promise.all([
        stmts.getAllStrategies.all(),
        stmts.getAllStrategyTradesChrono.all(),
    ]);

    const strategyById = new Map();
    for (const strategy of strategies || []) {
        strategyById.set(strategy.id, strategy);
        strategyFundMap.set(strategy.id, strategy.fund_id);
        getOrCreateState(strategy.id);
    }

    let restoredTrades = 0;
    for (const row of trades || []) {
        const strategy = strategyById.get(row.strategy_id);
        if (!strategy) continue;

        const side = String(row.side || '').toLowerCase();
        const qty = Number(row.quantity || 0);
        const price = Number(row.price || 0);
        const executedAt = Number(row.executed_at || 0);
        if (!['buy', 'sell'].includes(side)) continue;
        if (!Number.isFinite(qty) || qty <= 0) continue;
        if (!Number.isFinite(price) || price <= 0) continue;

        const state = getOrCreateState(row.strategy_id);
        updatePosition(state, row.ticker, side, qty, price);
        state.tradeCount += 1;
        state.lastSignal = side;
        state.lastRunAt = Math.max(Number(state.lastRunAt || 0), executedAt || 0);

        state.trades.push({
            id: row.id,
            ticker: row.ticker,
            side,
            quantity: qty,
            price,
            executed_at: executedAt || Date.now(),
            strategy_name: strategy.name,
        });
        if (state.trades.length > MAX_MEMORY_TRADES) state.trades.shift();
        restoredTrades += 1;
    }

    console.log(
        `[StrategyRunner] Hydrated ${strategyById.size} strategies and ${restoredTrades} strategy trades from DB`
    );
}

// ─── Execute a single strategy ──────────────────────────────────────────────
async function executeStrategy(strategy) {
    strategyFundMap.set(strategy.id, strategy.fund_id);
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

    const price = signal === 'buy' ? Number(priceData.ask) : Number(priceData.bid);
    if (!Number.isFinite(price) || price <= 0) return;
    const side = signal;
    const sizing = await resolveStrategyTradeSizing(strategy, config, price);
    const qty = sizing.qty;
    if (!Number.isFinite(qty) || qty <= 0) return;
    const now = Date.now();
    const tradeId = uuid();

    try {
        const riskCheck = await evaluateRiskGuards(strategy, state, side, ticker, qty, price);
        if (!riskCheck.allowed) {
            await recordRiskBreach(strategy, state, ticker, side, qty, price, riskCheck);
            return;
        }
    } catch (err) {
        console.error(`[StrategyRunner] Risk check failed for ${strategy.name}:`, err.message);
        return;
    }

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
async function start() {
    if (runnerInterval) return;
    try {
        await hydrateStateFromDb();
    } catch (err) {
        if (!isDbUnavailableError(err)) {
            console.error('[StrategyRunner] Hydration failed:', err.message);
        }
    }
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

module.exports = {
    start,
    stop,
    setPaused,
    getDashboardData,
    getFundRiskSnapshot,
    FUND_RISK_DEFAULTS,
    normalizeRiskSettings,
    runAll,
};
