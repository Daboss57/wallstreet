const crypto = require('crypto');
const { stmts } = require('./db');

const BACKTEST_DEPLOY_THRESHOLDS = {
    min_trades: 5,
    min_win_rate: 45,
    min_sharpe: 0.1,
    max_drawdown_pct: 25,
};

const DEFAULT_BARS = 500;
const MAX_BARS = 2000;
const MIN_BARS = 100;
const DEFAULT_INITIAL_CAPITAL = Math.max(10_000, Number.parseFloat(process.env.BACKTEST_INITIAL_CAPITAL || '100000'));

function stableStringify(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${parts.join(',')}}`;
}

function normalizeStrategyConfig(strategy) {
    const raw = strategy?.config;
    if (!raw) return {};
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    return raw;
}

function computeConfigHash(config) {
    const serialized = stableStringify(config || {});
    return crypto.createHash('sha256').update(serialized).digest('hex');
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeBacktestThresholds(input = {}) {
    return {
        min_trades: Math.floor(clampNumber(input.min_trades, BACKTEST_DEPLOY_THRESHOLDS.min_trades, 1, 500)),
        min_win_rate: clampNumber(input.min_win_rate, BACKTEST_DEPLOY_THRESHOLDS.min_win_rate, 0, 100),
        min_sharpe: clampNumber(input.min_sharpe, BACKTEST_DEPLOY_THRESHOLDS.min_sharpe, -10, 10),
        max_drawdown_pct: clampNumber(input.max_drawdown_pct, BACKTEST_DEPLOY_THRESHOLDS.max_drawdown_pct, 0.1, 100),
    };
}

async function getTickerSeries(ticker, interval, bars) {
    const rows = await stmts.getCandles.all(ticker, interval, bars);
    return rows
        .slice()
        .reverse()
        .map((row) => ({
            time: Number(row.open_time),
            close: Number(row.close),
        }))
        .filter((row) => Number.isFinite(row.close) && row.close > 0);
}

function alignPairSeries(seriesA, seriesB) {
    const mapB = new Map(seriesB.map((row) => [row.time, row.close]));
    const aligned = [];
    for (const rowA of seriesA) {
        const closeB = mapB.get(rowA.time);
        if (Number.isFinite(closeB) && closeB > 0) {
            aligned.push({
                time: rowA.time,
                closeA: rowA.close,
                closeB,
            });
        }
    }
    return aligned;
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values, mean) {
    if (!values.length) return 0;
    const variance = values.reduce((sum, v) => {
        const d = v - mean;
        return sum + (d * d);
    }, 0) / values.length;
    return Math.sqrt(variance);
}

function getUnrealizedPnl(position, price) {
    if (!position || !position.qty || !Number.isFinite(price) || price <= 0) return 0;
    if (position.qty > 0) return position.qty * (price - position.avgEntry);
    return Math.abs(position.qty) * (position.avgEntry - price);
}

function applyTrade(position, side, qty, price) {
    let remaining = Math.max(0, Number(qty) || 0);
    const next = {
        qty: Number(position.qty) || 0,
        avgEntry: Number(position.avgEntry) || 0,
        totalCost: Number(position.totalCost) || 0,
    };
    let realizedDelta = 0;

    if (remaining <= 0 || !Number.isFinite(price) || price <= 0) {
        return { position: next, realizedDelta: 0 };
    }

    if (side === 'buy') {
        if (next.qty < 0) {
            const closedQty = Math.min(remaining, Math.abs(next.qty));
            if (closedQty > 0) {
                realizedDelta += closedQty * (next.avgEntry - price);
                next.qty += closedQty;
                remaining -= closedQty;
                if (next.qty === 0) {
                    next.avgEntry = 0;
                    next.totalCost = 0;
                } else {
                    next.totalCost = Math.abs(next.qty) * next.avgEntry;
                }
            }
        }
        if (remaining > 0) {
            const existingLongQty = Math.max(next.qty, 0);
            const existingCost = existingLongQty * next.avgEntry;
            const newQty = existingLongQty + remaining;
            const newCost = existingCost + (remaining * price);
            next.qty = newQty;
            next.avgEntry = newQty > 0 ? (newCost / newQty) : 0;
            next.totalCost = newQty * next.avgEntry;
        }
    } else {
        if (next.qty > 0) {
            const closedQty = Math.min(remaining, next.qty);
            if (closedQty > 0) {
                realizedDelta += closedQty * (price - next.avgEntry);
                next.qty -= closedQty;
                remaining -= closedQty;
                if (next.qty === 0) {
                    next.avgEntry = 0;
                    next.totalCost = 0;
                } else {
                    next.totalCost = next.qty * next.avgEntry;
                }
            }
        }
        if (remaining > 0) {
            const existingShortQty = Math.abs(Math.min(next.qty, 0));
            const existingCost = existingShortQty * next.avgEntry;
            const newShortQty = existingShortQty + remaining;
            const newCost = existingCost + (remaining * price);
            next.qty = -newShortQty;
            next.avgEntry = newShortQty > 0 ? (newCost / newShortQty) : 0;
            next.totalCost = newShortQty * next.avgEntry;
        }
    }

    return { position: next, realizedDelta };
}

function summarizeMetrics({
    initialCapital,
    realizedPnl,
    unrealizedPnl,
    tradeCount,
    wins,
    losses,
    equityCurve,
    startedAt,
    endedAt,
    barsUsed,
    interval,
    extra = {},
}) {
    const totalPnl = realizedPnl + unrealizedPnl;
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

    let peak = initialCapital;
    let maxDrawdownPct = 0;
    for (const equity of equityCurve) {
        if (equity > peak) peak = equity;
        if (peak > 0) {
            const dd = ((peak - equity) / peak) * 100;
            if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        }
    }

    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
        const prev = equityCurve[i - 1];
        const curr = equityCurve[i];
        if (prev > 0) returns.push((curr - prev) / prev);
    }
    const mean = average(returns);
    const sigma = stdDev(returns, mean);
    let sharpe = 0;
    if (sigma > 0) {
        sharpe = (mean / sigma) * Math.sqrt(252);
    }
    if (!Number.isFinite(sharpe)) sharpe = 0;
    sharpe = Math.max(-25, Math.min(25, sharpe));

    return {
        initialCapital: +initialCapital.toFixed(2),
        finalEquity: +(initialCapital + totalPnl).toFixed(2),
        totalPnl: +totalPnl.toFixed(2),
        realizedPnl: +realizedPnl.toFixed(2),
        unrealizedPnl: +unrealizedPnl.toFixed(2),
        totalTrades: tradeCount,
        wins,
        losses,
        winRate: +winRate.toFixed(2),
        maxDrawdownPct: +maxDrawdownPct.toFixed(2),
        sharpe: +sharpe.toFixed(3),
        startedAt,
        endedAt,
        barsUsed,
        interval,
        ...extra,
    };
}

function evaluateDeployGate(metrics, thresholds) {
    const failures = [];
    if (metrics.totalTrades < thresholds.min_trades) {
        failures.push(`Trades ${metrics.totalTrades} < minimum ${thresholds.min_trades}`);
    }
    if (metrics.winRate < thresholds.min_win_rate) {
        failures.push(`Win rate ${metrics.winRate.toFixed(2)}% < minimum ${thresholds.min_win_rate.toFixed(2)}%`);
    }
    if (metrics.sharpe < thresholds.min_sharpe) {
        failures.push(`Sharpe ${metrics.sharpe.toFixed(3)} < minimum ${thresholds.min_sharpe.toFixed(3)}`);
    }
    if (metrics.maxDrawdownPct > thresholds.max_drawdown_pct) {
        failures.push(`Max drawdown ${metrics.maxDrawdownPct.toFixed(2)}% > maximum ${thresholds.max_drawdown_pct.toFixed(2)}%`);
    }
    return {
        passed: failures.length === 0,
        notes: failures.length === 0 ? 'Backtest passed deploy gate thresholds' : failures.join('; '),
        failures,
    };
}

function buildSingleSignalGenerator(strategyType, config) {
    if (strategyType === 'mean_reversion') {
        const period = Math.max(5, Math.floor(Number(config.period) || 20));
        const stdDevMultiplier = Math.max(0.5, Number(config.stdDevMultiplier) || 2);
        return (index, series) => {
            if (index < period - 1) return { action: 'hold', reason: 'warmup' };
            const recent = series.slice(index - period + 1, index + 1).map((row) => row.close);
            const mean = average(recent);
            const sigma = stdDev(recent, mean);
            const upper = mean + (sigma * stdDevMultiplier);
            const lower = mean - (sigma * stdDevMultiplier);
            const price = series[index].close;
            if (price < lower) return { action: 'buy', reason: 'below_lower_band' };
            if (price > upper) return { action: 'sell', reason: 'above_upper_band' };
            return { action: 'hold', reason: 'inside_band' };
        };
    }

    if (strategyType === 'momentum') {
        const period = Math.max(2, Math.floor(Number(config.period) || 14));
        return (index, series) => {
            if (index < period + 1) return { action: 'hold', reason: 'warmup' };
            const curr = ((series[index].close - series[index - period].close) / series[index - period].close) * 100;
            const prev = ((series[index - 1].close - series[index - 1 - period].close) / series[index - 1 - period].close) * 100;
            if (prev <= 0 && curr > 0) return { action: 'buy', reason: 'momentum_cross_up' };
            if (prev >= 0 && curr < 0) return { action: 'sell', reason: 'momentum_cross_down' };
            return { action: 'hold', reason: 'no_cross' };
        };
    }

    if (strategyType === 'grid') {
        const spacing = Math.max(0.01, Number(config.gridSpacing) || 1);
        const levels = Math.max(1, Math.floor(Number(config.gridLevels) || 5));
        const recenterThreshold = Math.max(0.5, Number(config.recenterThreshold) || 10);
        const state = {
            center: null,
            activeBuy: new Set(),
            activeSell: new Set(),
        };
        return (index, series) => {
            const price = series[index].close;
            if (!Number.isFinite(price) || price <= 0) return { action: 'hold', reason: 'invalid_price' };

            if (state.center === null) state.center = price;
            const movePct = Math.abs((price - state.center) / state.center) * 100;
            if (movePct >= recenterThreshold) {
                state.center = price;
                state.activeBuy.clear();
                state.activeSell.clear();
            }

            for (let i = 1; i <= levels; i++) {
                const level = -i;
                const levelPrice = state.center - (spacing * i);
                if (!state.activeBuy.has(level) && price <= levelPrice) {
                    state.activeBuy.add(level);
                    return { action: 'buy', reason: `grid_buy_${i}` };
                }
            }

            for (let i = 1; i <= levels; i++) {
                const level = i;
                const levelPrice = state.center + (spacing * i);
                if (!state.activeSell.has(level) && price >= levelPrice) {
                    state.activeSell.add(level);
                    return { action: 'sell', reason: `grid_sell_${i}` };
                }
            }

            return { action: 'hold', reason: 'inside_grid' };
        };
    }

    return null;
}

async function runSingleTickerBacktest(strategyType, config, options = {}) {
    const ticker = config.ticker;
    if (!ticker) throw new Error('Ticker missing in strategy config');
    const interval = config.interval || options.interval || '5m';
    const bars = clampNumber(options.bars, DEFAULT_BARS, MIN_BARS, MAX_BARS);
    const qtyPerTrade = Math.max(1, Math.floor(Number(config.positionSize) || 10));
    const signalFn = buildSingleSignalGenerator(strategyType, config);
    if (!signalFn) throw new Error(`Backtest unsupported for strategy type "${strategyType}"`);

    const series = await getTickerSeries(ticker, interval, bars);
    if (series.length < Math.max(50, MIN_BARS)) {
        throw new Error(`Insufficient candles for ${ticker} (${series.length} available)`);
    }

    let position = { qty: 0, avgEntry: 0, totalCost: 0 };
    let realizedPnl = 0;
    let wins = 0;
    let losses = 0;
    let tradeCount = 0;
    const equityCurve = [];
    const initialCapital = DEFAULT_INITIAL_CAPITAL;

    for (let i = 0; i < series.length; i++) {
        const { action } = signalFn(i, series);
        const price = series[i].close;
        if (action === 'buy' || action === 'sell') {
            const applied = applyTrade(position, action, qtyPerTrade, price);
            position = applied.position;
            realizedPnl += applied.realizedDelta;
            tradeCount += 1;
            if (applied.realizedDelta > 0) wins += 1;
            if (applied.realizedDelta < 0) losses += 1;
        }

        const unrealized = getUnrealizedPnl(position, price);
        equityCurve.push(initialCapital + realizedPnl + unrealized);
    }

    const finalUnrealized = getUnrealizedPnl(position, series[series.length - 1].close);
    const metrics = summarizeMetrics({
        initialCapital,
        realizedPnl,
        unrealizedPnl: finalUnrealized,
        tradeCount,
        wins,
        losses,
        equityCurve,
        startedAt: series[0].time,
        endedAt: series[series.length - 1].time,
        barsUsed: series.length,
        interval,
        extra: {
            ticker,
            positionSize: qtyPerTrade,
            lastPrice: +series[series.length - 1].close.toFixed(4),
        },
    });

    return { metrics };
}

async function runPairsBacktest(config, options = {}) {
    const tickerA = config.ticker;
    const tickerB = config.ticker2;
    if (!tickerA || !tickerB) throw new Error('Pairs strategy requires ticker and ticker2');

    const interval = config.interval || options.interval || '5m';
    const bars = clampNumber(options.bars, DEFAULT_BARS, MIN_BARS, MAX_BARS);
    const lookback = Math.max(5, Math.floor(Number(config.lookback) || 20));
    const threshold = Math.max(0.5, Number(config.stdDevThreshold) || 2);
    const qtyPerLeg = Math.max(1, Math.floor(Number(config.positionSize) || 10));

    const [seriesA, seriesB] = await Promise.all([
        getTickerSeries(tickerA, interval, bars),
        getTickerSeries(tickerB, interval, bars),
    ]);
    const aligned = alignPairSeries(seriesA, seriesB);
    if (aligned.length < lookback + 5) {
        throw new Error(`Insufficient aligned pair candles (${aligned.length} available)`);
    }

    let pairPosition = 'neutral';
    let posA = { qty: 0, avgEntry: 0, totalCost: 0 };
    let posB = { qty: 0, avgEntry: 0, totalCost: 0 };
    let realizedPnl = 0;
    let wins = 0;
    let losses = 0;
    let tradeCount = 0;
    const equityCurve = [];
    const spreads = aligned.map((row) => row.closeA / row.closeB);
    const initialCapital = DEFAULT_INITIAL_CAPITAL;

    for (let i = 0; i < aligned.length; i++) {
        const row = aligned[i];
        let actionA = 'hold';
        let actionB = 'hold';

        if (i >= lookback - 1) {
            const window = spreads.slice(i - lookback + 1, i + 1);
            const mean = average(window);
            const sigma = stdDev(window, mean);
            const upper = mean + (sigma * threshold);
            const lower = mean - (sigma * threshold);
            const current = spreads[i];

            if (current < lower && pairPosition !== 'longA_shortB') {
                actionA = 'buy';
                actionB = 'sell';
                pairPosition = 'longA_shortB';
            } else if (current > upper && pairPosition !== 'shortA_longB') {
                actionA = 'sell';
                actionB = 'buy';
                pairPosition = 'shortA_longB';
            } else if (pairPosition === 'longA_shortB' && current >= mean) {
                actionA = 'sell';
                actionB = 'buy';
                pairPosition = 'neutral';
            } else if (pairPosition === 'shortA_longB' && current <= mean) {
                actionA = 'buy';
                actionB = 'sell';
                pairPosition = 'neutral';
            }
        }

        if (actionA !== 'hold' || actionB !== 'hold') {
            const before = realizedPnl;
            const legA = applyTrade(posA, actionA, qtyPerLeg, row.closeA);
            posA = legA.position;
            realizedPnl += legA.realizedDelta;
            const legB = applyTrade(posB, actionB, qtyPerLeg, row.closeB);
            posB = legB.position;
            realizedPnl += legB.realizedDelta;
            tradeCount += 1;
            const delta = realizedPnl - before;
            if (delta > 0) wins += 1;
            if (delta < 0) losses += 1;
        }

        const unrealized = getUnrealizedPnl(posA, row.closeA) + getUnrealizedPnl(posB, row.closeB);
        equityCurve.push(initialCapital + realizedPnl + unrealized);
    }

    const last = aligned[aligned.length - 1];
    const finalUnrealized = getUnrealizedPnl(posA, last.closeA) + getUnrealizedPnl(posB, last.closeB);
    const metrics = summarizeMetrics({
        initialCapital,
        realizedPnl,
        unrealizedPnl: finalUnrealized,
        tradeCount,
        wins,
        losses,
        equityCurve,
        startedAt: aligned[0].time,
        endedAt: aligned[aligned.length - 1].time,
        barsUsed: aligned.length,
        interval,
        extra: {
            tickerA,
            tickerB,
            positionSize: qtyPerLeg,
            lookback,
            stdDevThreshold: threshold,
            spreadLast: +(spreads[spreads.length - 1]).toFixed(6),
        },
    });

    return { metrics };
}

async function runStrategyBacktest(strategy, options = {}) {
    if (!strategy) throw new Error('Strategy is required');

    const config = normalizeStrategyConfig(strategy);
    const thresholds = normalizeBacktestThresholds(options.thresholds || {});
    const configHash = computeConfigHash(config);
    const configSnapshot = config;

    let runResult;
    if (strategy.type === 'pairs') {
        runResult = await runPairsBacktest(config, options);
    } else {
        runResult = await runSingleTickerBacktest(strategy.type, config, options);
    }

    const gate = evaluateDeployGate(runResult.metrics, thresholds);
    return {
        configHash,
        configSnapshot,
        thresholds,
        metrics: runResult.metrics,
        passed: gate.passed,
        notes: gate.notes,
        failures: gate.failures,
    };
}

module.exports = {
    runStrategyBacktest,
    BACKTEST_DEPLOY_THRESHOLDS,
    normalizeBacktestThresholds,
    normalizeStrategyConfig,
    computeConfigHash,
};
