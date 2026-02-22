function toNum(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 2) {
    const factor = 10 ** decimals;
    return Math.round((toNum(value, 0) + Number.EPSILON) * factor) / factor;
}

function envBool(name, fallback = true) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const EXECUTION_REALISM_ENABLED = envBool('EXECUTION_REALISM_ENABLED', true);

const CLASS_BORROW_APR_DEFAULTS = {
    Stock: 0.03,
    ETF: 0.02,
    Future: 0.01,
    Crypto: 0.08,
    Forex: 0.015,
    Commodity: 0.025,
};

const CLASS_MICROSTRUCTURE_DEFAULTS = {
    Stock: {
        avg_daily_dollar_volume: 2_500_000_000,
        base_spread_bps: 2.4,
        impact_coeff: 65,
        commission_bps: 1,
        commission_min_usd: 0.01,
    },
    ETF: {
        avg_daily_dollar_volume: 1_200_000_000,
        base_spread_bps: 1.6,
        impact_coeff: 52,
        commission_bps: 1,
        commission_min_usd: 0.01,
    },
    Future: {
        avg_daily_dollar_volume: 4_000_000_000,
        base_spread_bps: 1.8,
        impact_coeff: 58,
        commission_bps: 0.8,
        commission_min_usd: 0.01,
    },
    Commodity: {
        avg_daily_dollar_volume: 900_000_000,
        base_spread_bps: 4.5,
        impact_coeff: 78,
        commission_bps: 1.2,
        commission_min_usd: 0.01,
    },
    Forex: {
        avg_daily_dollar_volume: 5_000_000_000,
        base_spread_bps: 0.8,
        impact_coeff: 42,
        commission_bps: 0.6,
        commission_min_usd: 0.01,
    },
    Crypto: {
        avg_daily_dollar_volume: 800_000_000,
        base_spread_bps: 6,
        impact_coeff: 110,
        commission_bps: 1.4,
        commission_min_usd: 0.01,
    },
};

const RECENT_FILL_METRICS = [];
const FILL_METRIC_MEMORY_MS = 15 * 60 * 1000;
const MAX_FILL_METRICS = 5000;

function resolveMicrostructure(tickerDef = {}) {
    const classDefaults = CLASS_MICROSTRUCTURE_DEFAULTS[tickerDef.class] || CLASS_MICROSTRUCTURE_DEFAULTS.Stock;
    const borrowDefault = CLASS_BORROW_APR_DEFAULTS[tickerDef.class] ?? CLASS_BORROW_APR_DEFAULTS.Stock;
    return {
        avg_daily_dollar_volume: Math.max(1, toNum(
            tickerDef.avg_daily_dollar_volume ?? classDefaults.avg_daily_dollar_volume,
            classDefaults.avg_daily_dollar_volume
        )),
        base_spread_bps: Math.max(0, toNum(
            tickerDef.base_spread_bps ?? classDefaults.base_spread_bps,
            classDefaults.base_spread_bps
        )),
        impact_coeff: Math.max(0, toNum(
            tickerDef.impact_coeff ?? classDefaults.impact_coeff,
            classDefaults.impact_coeff
        )),
        commission_bps: Math.max(0, toNum(
            tickerDef.commission_bps ?? classDefaults.commission_bps,
            classDefaults.commission_bps
        )),
        commission_min_usd: Math.max(0, toNum(
            tickerDef.commission_min_usd ?? classDefaults.commission_min_usd,
            classDefaults.commission_min_usd
        )),
        borrow_apr_short: Math.max(0, toNum(
            tickerDef.borrow_apr_short ?? borrowDefault,
            borrowDefault
        )),
    };
}

function resolveRegimeMultipliers(regime = null) {
    return {
        regime: String(regime?.regime || regime?.name || 'normal'),
        liquidity_mult: Math.max(0.25, toNum(regime?.liquidity_mult, 1)),
        vol_mult: Math.max(0.25, toNum(regime?.vol_mult, 1)),
        news_mult: Math.max(0.25, toNum(regime?.news_mult, 1)),
        borrow_mult: Math.max(0.25, toNum(regime?.borrow_mult, 1)),
    };
}

function getVolatilityMultiplier(volatility = 0) {
    const vol = Math.max(0, toNum(volatility, 0));
    return clamp(1 + (vol * 25), 0.85, 4);
}

function estimateExecution({
    tickerDef,
    side,
    qty,
    reference_price,
    mid_price,
    volatility,
    regime = null,
    opens_short_qty = 0,
    apply_realism = EXECUTION_REALISM_ENABLED,
}) {
    const normalizedQty = Math.max(0, toNum(qty, 0));
    const referencePrice = Math.max(0, toNum(reference_price, 0));
    const midPrice = Math.max(0.0000001, toNum(mid_price, referencePrice));
    const direction = String(side || '').toLowerCase() === 'sell' ? -1 : 1;

    if (!apply_realism) {
        return {
            fill_price: round(referencePrice, 8),
            mid_price: round(midPrice, 8),
            slippage_bps: 0,
            slippage_cost: 0,
            commission: 0,
            borrow_cost: 0,
            notional: round(referencePrice * normalizedQty, 2),
            execution_quality_score: 100,
            regime: 'legacy',
        };
    }

    const micro = resolveMicrostructure(tickerDef);
    const regimeMultipliers = resolveRegimeMultipliers(regime);

    const referenceNotional = referencePrice * normalizedQty;
    const impactRatio = referenceNotional / micro.avg_daily_dollar_volume;
    const volatilityMultiplier = getVolatilityMultiplier(volatility);
    const impactBps = micro.base_spread_bps
        + (micro.impact_coeff * (impactRatio ** 0.6) * regimeMultipliers.liquidity_mult * volatilityMultiplier);

    const fillPrice = referencePrice * (1 + (direction * impactBps / 10000));
    const executionNotional = normalizedQty * fillPrice;
    const slippageCost = direction > 0
        ? (fillPrice - midPrice) * normalizedQty
        : (midPrice - fillPrice) * normalizedQty;
    const commission = Math.max(
        micro.commission_min_usd,
        executionNotional * (micro.commission_bps / 10000)
    );
    const opensShortQty = Math.max(0, toNum(opens_short_qty, 0));
    const borrowCost = opensShortQty > 0
        ? (opensShortQty * fillPrice) * ((micro.borrow_apr_short * regimeMultipliers.borrow_mult) / 365)
        : 0;
    const totalCost = Math.max(0, slippageCost) + commission + borrowCost;
    const commissionBps = executionNotional > 0 ? (commission / executionNotional) * 10000 : 0;
    const borrowBps = executionNotional > 0 ? (borrowCost / executionNotional) * 10000 : 0;
    const qualityScore = clamp(
        100 - ((impactBps * 0.6) + (commissionBps * 0.3) + (borrowBps * 0.1)),
        0,
        100
    );

    return {
        fill_price: round(fillPrice, 8),
        mid_price: round(midPrice, 8),
        slippage_bps: round(impactBps, 4),
        slippage_cost: round(Math.max(0, slippageCost), 4),
        commission: round(commission, 4),
        borrow_cost: round(borrowCost, 4),
        notional: round(executionNotional, 4),
        total_cost: round(totalCost, 4),
        execution_quality_score: round(qualityScore, 4),
        regime: regimeMultipliers.regime,
        volatility_multiplier: round(volatilityMultiplier, 4),
    };
}

function estimateOrder({
    tickerDef,
    side,
    qty,
    reference_price,
    mid_price,
    volatility,
    opens_short_qty = 0,
    regime = null,
}) {
    const breakdown = estimateExecution({
        tickerDef,
        side,
        qty,
        reference_price,
        mid_price,
        volatility,
        opens_short_qty,
        regime,
        apply_realism: EXECUTION_REALISM_ENABLED,
    });
    return {
        est_slippage_bps: round(breakdown.slippage_bps, 4),
        est_slippage_cost: round(breakdown.slippage_cost, 4),
        est_commission: round(breakdown.commission, 4),
        est_borrow_day: round(breakdown.borrow_cost, 4),
        est_total_cost: round((breakdown.slippage_cost + breakdown.commission + breakdown.borrow_cost), 4),
        est_fill_price: round(breakdown.fill_price, 8),
        est_execution_quality_score: round(breakdown.execution_quality_score, 2),
        regime: breakdown.regime,
    };
}

function estimateBorrowAccrual({
    notional,
    borrow_apr_short,
    elapsed_ms,
    regime = null,
}) {
    if (!EXECUTION_REALISM_ENABLED) return 0;
    const borrowApr = Math.max(0, toNum(borrow_apr_short, 0));
    const elapsedMs = Math.max(0, toNum(elapsed_ms, 0));
    const regimeMultipliers = resolveRegimeMultipliers(regime);
    const adjustedApr = borrowApr * regimeMultipliers.borrow_mult;
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    const accrual = Math.max(0, toNum(notional, 0)) * adjustedApr * (elapsedMs / yearMs);
    return round(accrual, 8);
}

function recordFillMetrics({
    timestamp = Date.now(),
    slippage_bps = 0,
    execution_quality_score = 100,
} = {}) {
    const ts = toNum(timestamp, Date.now());
    RECENT_FILL_METRICS.push({
        timestamp: ts,
        slippage_bps: toNum(slippage_bps, 0),
        execution_quality_score: toNum(execution_quality_score, 100),
    });
    while (RECENT_FILL_METRICS.length > MAX_FILL_METRICS) RECENT_FILL_METRICS.shift();
    const cutoff = ts - FILL_METRIC_MEMORY_MS;
    while (RECENT_FILL_METRICS.length && RECENT_FILL_METRICS[0].timestamp < cutoff) {
        RECENT_FILL_METRICS.shift();
    }
}

function getRecentMetrics(windowMs = 5 * 60 * 1000) {
    const now = Date.now();
    const cutoff = now - Math.max(1000, toNum(windowMs, 5 * 60 * 1000));
    let count = 0;
    let slippageSum = 0;
    let qualitySum = 0;
    for (let i = RECENT_FILL_METRICS.length - 1; i >= 0; i -= 1) {
        const point = RECENT_FILL_METRICS[i];
        if (point.timestamp < cutoff) break;
        count += 1;
        slippageSum += point.slippage_bps;
        qualitySum += point.execution_quality_score;
    }
    return {
        count,
        avg_slippage_bps: count > 0 ? round(slippageSum / count, 4) : 0,
        avg_execution_quality: count > 0 ? round(qualitySum / count, 4) : 0,
    };
}

function isExecutionRealismEnabled() {
    return EXECUTION_REALISM_ENABLED;
}

module.exports = {
    CLASS_MICROSTRUCTURE_DEFAULTS,
    CLASS_BORROW_APR_DEFAULTS,
    resolveMicrostructure,
    resolveRegimeMultipliers,
    estimateExecution,
    estimateOrder,
    estimateBorrowAccrual,
    recordFillMetrics,
    getRecentMetrics,
    isExecutionRealismEnabled,
};
