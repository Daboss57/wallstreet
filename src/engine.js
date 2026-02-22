const { v4: uuid } = require('uuid');
const { stmts, batchUpsertCandles, batchUpsertPriceStates, isDbUnavailableError } = require('./db');
const { resolveMicrostructure } = require('./executionModel');

function boundedFloat(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function envBool(name, fallback = true) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function mergeTickerStyle(base, override = {}) {
    const merged = { ...base, ...override };
    const baseFactors = base.factorLoadings || {};
    const overrideFactors = override.factorLoadings || {};
    merged.factorLoadings = { ...baseFactors, ...overrideFactors };
    return merged;
}

const MARKET_VOLATILITY_MULTIPLIER = boundedFloat(process.env.MARKET_VOLATILITY_MULTIPLIER, 0.35, 0.05, 2.0);
const MARKET_SHOCK_MULTIPLIER = boundedFloat(process.env.MARKET_SHOCK_MULTIPLIER, 0.55, 0.05, 2.0);
const MARKET_SPREAD_MULTIPLIER = boundedFloat(process.env.MARKET_SPREAD_MULTIPLIER, 0.65, 0.05, 3.0);
const MARKET_ORDER_FLOW_MULTIPLIER = boundedFloat(process.env.MARKET_ORDER_FLOW_MULTIPLIER, 0.4, 0.0, 3.0);
const MARKET_GARCH_ALPHA = boundedFloat(process.env.MARKET_GARCH_ALPHA, 0.06, 0.01, 0.4);
const MARKET_GARCH_BETA = boundedFloat(process.env.MARKET_GARCH_BETA, 0.9, 0.5, 0.99);
const MARKET_VOL_MIN_FACTOR = boundedFloat(process.env.MARKET_VOL_MIN_FACTOR, 0.15, 0.01, 1.0);
const MARKET_VOL_MAX_FACTOR = boundedFloat(process.env.MARKET_VOL_MAX_FACTOR, 1.75, 0.2, 10.0);
const MARKET_NEWS_VOL_SPIKE_MULTIPLIER = boundedFloat(process.env.MARKET_NEWS_VOL_SPIKE_MULTIPLIER, 1.35, 1.0, 5.0);
const MARKET_MIN_PRICE_FACTOR = boundedFloat(process.env.MARKET_MIN_PRICE_FACTOR, 0.55, 0.05, 2.0);
const MARKET_HARD_MIN_PRICE_FACTOR = boundedFloat(process.env.MARKET_HARD_MIN_PRICE_FACTOR, 0.12, 0.01, 1.0);
const MARKET_MAX_PRICE_FACTOR = boundedFloat(process.env.MARKET_MAX_PRICE_FACTOR, 1.85, 1.0, 10.0);
const MARKET_MAX_TICK_MOVE_PCT = boundedFloat(process.env.MARKET_MAX_TICK_MOVE_PCT, 0.0035, 0.0005, 0.05);
const MARKET_MAX_NEWS_MOVE_PCT = boundedFloat(process.env.MARKET_MAX_NEWS_MOVE_PCT, 0.025, 0.002, 0.3);
const MARKET_MEAN_REVERSION_MULTIPLIER = boundedFloat(process.env.MARKET_MEAN_REVERSION_MULTIPLIER, 2.5, 0.2, 10.0);
const MARKET_ORDER_FLOW_DECAY = boundedFloat(process.env.MARKET_ORDER_FLOW_DECAY, 0.25, 0.01, 0.95);
const MARKET_MAX_ORDER_FLOW_MOVE_PCT = boundedFloat(process.env.MARKET_MAX_ORDER_FLOW_MOVE_PCT, 0.0015, 0.0001, 0.05);
const MARKET_REGIME_ENABLED = envBool('MARKET_REGIME_ENABLED', true);
const MARKET_REGIME_REVIEW_INTERVAL_MS = boundedInt(process.env.MARKET_REGIME_REVIEW_INTERVAL_MS, 4 * 60 * 1000, 60_000, 30 * 60 * 1000);
const MARKET_EVENT_SHOCK_DURATION_MS = boundedInt(process.env.MARKET_EVENT_SHOCK_DURATION_MS, 3 * 60 * 1000, 30_000, 30 * 60 * 1000);

function getRiskMultiplier(definition) {
    if (definition.class === 'Crypto') return 1.35;
    if (definition.class === 'Stock' && definition.sector === 'Meme') return 1.25;
    if (definition.class === 'Future' && definition.sector === 'Volatility') return 1.4;
    return 1.0;
}

function getVolatilityRange(definition) {
    const risk = getRiskMultiplier(definition);
    const scaledBase = definition.volatility * MARKET_VOLATILITY_MULTIPLIER;
    return {
        baseVolatility: scaledBase,
        minVolatility: scaledBase * MARKET_VOL_MIN_FACTOR,
        maxVolatility: scaledBase * MARKET_VOL_MAX_FACTOR * risk,
    };
}

function getPriceBounds(definition, anchorPrice = null) {
    const risk = getRiskMultiplier(definition);
    const staticMin = definition.basePrice * MARKET_MIN_PRICE_FACTOR / risk;
    const dynamicAnchor = Number.isFinite(Number(anchorPrice)) && Number(anchorPrice) > 0
        ? Number(anchorPrice)
        : definition.basePrice;
    // Let lower bound drift downward with persistent moves, but keep a hard crash floor.
    const adaptiveMin = Math.min(staticMin, dynamicAnchor * MARKET_MIN_PRICE_FACTOR / risk);
    const hardMin = definition.basePrice * MARKET_HARD_MIN_PRICE_FACTOR / risk;
    return {
        minPrice: Math.max(0.01, hardMin, adaptiveMin),
        maxPrice: definition.basePrice * MARKET_MAX_PRICE_FACTOR * risk,
    };
}

function getMaxTickMovePct(definition) {
    return MARKET_MAX_TICK_MOVE_PCT * getRiskMultiplier(definition);
}

function getMaxNewsMovePct(definition) {
    return MARKET_MAX_NEWS_MOVE_PCT * getRiskMultiplier(definition);
}

// ─── Ticker Definitions (30+ instruments across 7 asset classes) ───────────────
const TICKERS = {
    // Stocks — Large Cap
    AAPL: { name: 'Apricot Corp', class: 'Stock', sector: 'Tech', basePrice: 185, volatility: 0.018, drift: 0.0001, meanRev: 0.002 },
    MSFT: { name: 'MegaSoft', class: 'Stock', sector: 'Tech', basePrice: 420, volatility: 0.016, drift: 0.00012, meanRev: 0.002 },
    NVDA: { name: 'NeuraVolt', class: 'Stock', sector: 'Tech', basePrice: 875, volatility: 0.032, drift: 0.0002, meanRev: 0.0015 },
    AMZN: { name: 'AmazoNet', class: 'Stock', sector: 'Tech', basePrice: 195, volatility: 0.02, drift: 0.00015, meanRev: 0.002 },
    GOOG: { name: 'GooglTech', class: 'Stock', sector: 'Tech', basePrice: 175, volatility: 0.019, drift: 0.0001, meanRev: 0.002 },
    META: { name: 'MetaVerse Inc', class: 'Stock', sector: 'Tech', basePrice: 510, volatility: 0.025, drift: 0.00015, meanRev: 0.0018 },
    TSLA: { name: 'VoltMotors', class: 'Stock', sector: 'Auto', basePrice: 245, volatility: 0.038, drift: 0.0002, meanRev: 0.001 },
    // Stocks — Growth / Speculative
    MOON: { name: 'LunarTech', class: 'Stock', sector: 'Meme', basePrice: 42, volatility: 0.065, drift: 0.0005, meanRev: 0.0005 },
    BIOT: { name: 'BioTera', class: 'Stock', sector: 'Healthcare', basePrice: 78, volatility: 0.04, drift: 0.0003, meanRev: 0.001 },
    QNTM: { name: 'QuantumLeap', class: 'Stock', sector: 'Tech', basePrice: 34, volatility: 0.045, drift: 0.0003, meanRev: 0.001 },
    // Commodities
    OGLD: { name: 'OmniGold', class: 'Commodity', sector: 'Metals', basePrice: 2050, volatility: 0.012, drift: 0.00005, meanRev: 0.003 },
    SLVR: { name: 'SilverEdge', class: 'Commodity', sector: 'Metals', basePrice: 28.5, volatility: 0.022, drift: 0.00003, meanRev: 0.003 },
    CRUD: { name: 'CrudeFlow', class: 'Commodity', sector: 'Energy', basePrice: 78, volatility: 0.025, drift: 0.0, meanRev: 0.004 },
    NATG: { name: 'NatGas Plus', class: 'Commodity', sector: 'Energy', basePrice: 3.2, volatility: 0.04, drift: 0.0, meanRev: 0.005 },
    COPR: { name: 'CopperLine', class: 'Commodity', sector: 'Metals', basePrice: 4.25, volatility: 0.018, drift: 0.00005, meanRev: 0.003 },
    // Futures / Indices
    SPXF: { name: 'S&P Futures', class: 'Future', sector: 'Index', basePrice: 5200, volatility: 0.012, drift: 0.0001, meanRev: 0.002 },
    NQFT: { name: 'NQ Futures', class: 'Future', sector: 'Index', basePrice: 18500, volatility: 0.016, drift: 0.00012, meanRev: 0.002 },
    DOWF: { name: 'Dow Futures', class: 'Future', sector: 'Index', basePrice: 39000, volatility: 0.01, drift: 0.00008, meanRev: 0.002 },
    VIXF: { name: 'Fear Index', class: 'Future', sector: 'Volatility', basePrice: 18, volatility: 0.06, drift: -0.0002, meanRev: 0.008 },
    // ETFs
    SAFE: { name: 'Treasury ETF', class: 'ETF', sector: 'Bonds', basePrice: 102, volatility: 0.003, drift: 0.00003, meanRev: 0.005 },
    BNKX: { name: 'BankEx ETF', class: 'ETF', sector: 'Finance', basePrice: 45, volatility: 0.014, drift: 0.00006, meanRev: 0.003 },
    NRGY: { name: 'Energy ETF', class: 'ETF', sector: 'Energy', basePrice: 88, volatility: 0.022, drift: 0.00008, meanRev: 0.003 },
    MEDS: { name: 'HealthCare ETF', class: 'ETF', sector: 'Healthcare', basePrice: 155, volatility: 0.015, drift: 0.0001, meanRev: 0.003 },
    SEMX: { name: 'SemiConductor ETF', class: 'ETF', sector: 'Tech', basePrice: 240, volatility: 0.028, drift: 0.00015, meanRev: 0.002 },
    REIT: { name: 'RealtyFund ETF', class: 'ETF', sector: 'RealEstate', basePrice: 38, volatility: 0.012, drift: 0.00005, meanRev: 0.004 },
    // Crypto
    BTCX: { name: 'Bitcoin Index', class: 'Crypto', sector: 'Crypto', basePrice: 67500, volatility: 0.035, drift: 0.0002, meanRev: 0.001 },
    ETHX: { name: 'Ethereum Index', class: 'Crypto', sector: 'Crypto', basePrice: 3500, volatility: 0.04, drift: 0.00015, meanRev: 0.001 },
    SOLX: { name: 'Solana Index', class: 'Crypto', sector: 'Crypto', basePrice: 145, volatility: 0.055, drift: 0.0003, meanRev: 0.0008 },
    // Forex (quoted as full pairs)
    EURUSD: { name: 'Euro/Dollar', class: 'Forex', sector: 'FX', basePrice: 1.0850, volatility: 0.004, drift: 0.0, meanRev: 0.006 },
    GBPUSD: { name: 'Pound/Dollar', class: 'Forex', sector: 'FX', basePrice: 1.2700, volatility: 0.005, drift: 0.0, meanRev: 0.006 },
    USDJPY: { name: 'Dollar/Yen', class: 'Forex', sector: 'FX', basePrice: 150.50, volatility: 0.005, drift: 0.0, meanRev: 0.005 },
};

function computeLiquidityScore(avgDailyDollarVolume) {
    const volume = Math.max(1, Number(avgDailyDollarVolume) || 1);
    const logScale = Math.log10(volume);
    const normalized = clamp((logScale - 6.5) / 3.5, 0, 1);
    return Math.round(normalized * 100);
}

for (const [ticker, def] of Object.entries(TICKERS)) {
    const micro = resolveMicrostructure(def);
    TICKERS[ticker] = {
        ...def,
        ...micro,
        liquidity_score: computeLiquidityScore(micro.avg_daily_dollar_volume),
    };
}

const TICKER_LIST = Object.keys(TICKERS);

const REGIME_PROFILES = {
    normal: {
        regime: 'normal',
        liquidity_mult: 1.0,
        vol_mult: 1.0,
        news_mult: 1.0,
        borrow_mult: 1.0,
    },
    tight_liquidity: {
        regime: 'tight_liquidity',
        liquidity_mult: 1.45,
        vol_mult: 1.15,
        news_mult: 1.1,
        borrow_mult: 1.2,
    },
    high_volatility: {
        regime: 'high_volatility',
        liquidity_mult: 1.2,
        vol_mult: 1.5,
        news_mult: 1.2,
        borrow_mult: 1.25,
    },
    event_shock: {
        regime: 'event_shock',
        liquidity_mult: 2.1,
        vol_mult: 2.0,
        news_mult: 1.55,
        borrow_mult: 1.5,
    },
};

const MARKET_FACTOR_NAMES = ['riskOn', 'usd', 'rates', 'energy', 'metals', 'crypto', 'vol'];
const marketFactors = {
    riskOn: 0,
    usd: 0,
    rates: 0,
    energy: 0,
    metals: 0,
    crypto: 0,
    vol: 0,
};

const DEFAULT_TICKER_STYLE = {
    trendPersistence: 0.35,
    idioShockMult: 1.0,
    jumpProb: 0.002,
    jumpScale: 2.1,
    meanReversionMult: 1.0,
    anchorFollow: 0.006,
    dynamicAnchorWeight: 0.6,
    spreadMult: 1.0,
    volumeBase: 80,
    volumeJitter: 520,
    volumeMoveMult: 240,
    volumeVolMult: 4.2,
    volOfVol: 1.0,
    maxTickMoveMult: 1.0,
    factorLoadings: {
        riskOn: 0,
        usd: 0,
        rates: 0,
        energy: 0,
        metals: 0,
        crypto: 0,
        vol: 0,
    },
};

const TICKER_STYLE_OVERRIDES = {
    AAPL: { trendPersistence: 0.56, factorLoadings: { riskOn: 0.75, rates: -0.22 } },
    MSFT: { trendPersistence: 0.54, factorLoadings: { riskOn: 0.72, rates: -0.2 } },
    NVDA: { idioShockMult: 1.45, jumpProb: 0.0045, jumpScale: 2.6, trendPersistence: 0.65, factorLoadings: { riskOn: 1.0, vol: -0.35 } },
    TSLA: { idioShockMult: 1.55, jumpProb: 0.006, jumpScale: 2.9, trendPersistence: 0.68, factorLoadings: { riskOn: 1.1, rates: -0.26 } },
    MOON: { idioShockMult: 2.3, jumpProb: 0.011, jumpScale: 3.4, trendPersistence: 0.73, spreadMult: 1.7, volumeMoveMult: 360, factorLoadings: { riskOn: 1.35, vol: -0.4 } },
    BIOT: { idioShockMult: 1.45, jumpProb: 0.0055, jumpScale: 2.6 },
    QNTM: { idioShockMult: 1.6, jumpProb: 0.007, jumpScale: 2.7 },
    OGLD: { meanReversionMult: 1.25, dynamicAnchorWeight: 0.2, factorLoadings: { riskOn: -0.42, usd: -0.72, rates: -0.4, metals: 1.35, vol: 0.35 } },
    SLVR: { idioShockMult: 1.18, factorLoadings: { riskOn: 0.08, usd: -0.62, metals: 1.4, energy: 0.16 } },
    CRUD: { jumpProb: 0.0045, jumpScale: 2.55, idioShockMult: 1.22, factorLoadings: { energy: 1.45, usd: -0.35, riskOn: 0.2 } },
    NATG: { jumpProb: 0.0068, jumpScale: 2.9, idioShockMult: 1.45, spreadMult: 1.28, factorLoadings: { energy: 1.85, usd: -0.28 } },
    COPR: { factorLoadings: { riskOn: 0.45, usd: -0.4, metals: 0.65, energy: 0.24 } },
    SPXF: { trendPersistence: 0.58, factorLoadings: { riskOn: 1.18, rates: -0.34, usd: -0.12, vol: -0.5 } },
    NQFT: { trendPersistence: 0.62, idioShockMult: 1.12, factorLoadings: { riskOn: 1.32, rates: -0.46, usd: -0.1, vol: -0.62 } },
    DOWF: { trendPersistence: 0.54, factorLoadings: { riskOn: 1.0, rates: -0.24, usd: -0.08, vol: -0.42 } },
    VIXF: {
        trendPersistence: 0.18,
        idioShockMult: 1.48,
        jumpProb: 0.0075,
        jumpScale: 3.1,
        meanReversionMult: 2.2,
        dynamicAnchorWeight: 0.1,
        spreadMult: 1.35,
        factorLoadings: { riskOn: -2.35, vol: 2.1, rates: 0.22 },
    },
    SAFE: { trendPersistence: 0.2, idioShockMult: 0.55, meanReversionMult: 1.7, dynamicAnchorWeight: 0.12, spreadMult: 0.72, factorLoadings: { rates: -0.9, riskOn: -0.18, usd: 0.15 } },
    BNKX: { trendPersistence: 0.47, factorLoadings: { riskOn: 0.62, rates: 0.72, vol: -0.2 } },
    NRGY: { trendPersistence: 0.45, factorLoadings: { riskOn: 0.55, energy: 1.0, usd: -0.15 } },
    MEDS: { trendPersistence: 0.42, factorLoadings: { riskOn: 0.45, rates: -0.18, vol: -0.15 } },
    SEMX: { trendPersistence: 0.56, idioShockMult: 1.22, factorLoadings: { riskOn: 1.0, rates: -0.42, vol: -0.35 } },
    REIT: { trendPersistence: 0.3, meanReversionMult: 1.25, factorLoadings: { rates: -0.82, riskOn: 0.28 } },
    BTCX: {
        trendPersistence: 0.66,
        idioShockMult: 1.4,
        jumpProb: 0.006,
        jumpScale: 2.95,
        meanReversionMult: 0.72,
        spreadMult: 1.35,
        volumeMoveMult: 340,
        factorLoadings: { crypto: 1.7, riskOn: 0.9, usd: -0.55, vol: -0.45 },
    },
    ETHX: {
        trendPersistence: 0.68,
        idioShockMult: 1.58,
        jumpProb: 0.0078,
        jumpScale: 3.05,
        meanReversionMult: 0.68,
        spreadMult: 1.5,
        volumeMoveMult: 360,
        factorLoadings: { crypto: 1.95, riskOn: 1.02, usd: -0.62, vol: -0.5 },
    },
    SOLX: {
        trendPersistence: 0.72,
        idioShockMult: 1.95,
        jumpProb: 0.01,
        jumpScale: 3.25,
        meanReversionMult: 0.55,
        spreadMult: 1.72,
        volumeMoveMult: 420,
        factorLoadings: { crypto: 2.25, riskOn: 1.22, usd: -0.7, vol: -0.56 },
    },
    EURUSD: { trendPersistence: 0.28, idioShockMult: 0.8, meanReversionMult: 1.65, dynamicAnchorWeight: 0.2, spreadMult: 0.62, factorLoadings: { usd: -1.45, rates: 0.35, riskOn: 0.12 } },
    GBPUSD: { trendPersistence: 0.3, idioShockMult: 0.86, meanReversionMult: 1.6, dynamicAnchorWeight: 0.24, spreadMult: 0.66, factorLoadings: { usd: -1.22, rates: 0.4, riskOn: 0.15 } },
    USDJPY: { trendPersistence: 0.34, idioShockMult: 0.9, meanReversionMult: 1.45, dynamicAnchorWeight: 0.28, spreadMult: 0.68, factorLoadings: { usd: 1.18, rates: 0.6, riskOn: 0.35 } },
};

function buildClassStyle(definition) {
    const style = { ...DEFAULT_TICKER_STYLE, factorLoadings: { ...DEFAULT_TICKER_STYLE.factorLoadings } };
    if (definition.class === 'Stock') {
        return mergeTickerStyle(style, {
            trendPersistence: 0.5,
            idioShockMult: 1.05,
            jumpProb: 0.0032,
            jumpScale: 2.35,
            meanReversionMult: 0.9,
            spreadMult: 0.95,
            factorLoadings: { riskOn: 0.72, rates: -0.2, usd: -0.08, vol: -0.22 },
        });
    }
    if (definition.class === 'Commodity') {
        return mergeTickerStyle(style, {
            trendPersistence: 0.4,
            idioShockMult: 1.12,
            jumpProb: 0.0038,
            jumpScale: 2.45,
            meanReversionMult: 1.15,
            spreadMult: 1.05,
            factorLoadings: { energy: 0.45, metals: 0.45, usd: -0.25, riskOn: 0.05, vol: 0.12 },
        });
    }
    if (definition.class === 'Future') {
        return mergeTickerStyle(style, {
            trendPersistence: 0.52,
            idioShockMult: 1.0,
            jumpProb: 0.0028,
            jumpScale: 2.2,
            meanReversionMult: 0.95,
            spreadMult: 0.92,
            factorLoadings: { riskOn: 1.0, rates: -0.24, usd: -0.06, vol: -0.35 },
        });
    }
    if (definition.class === 'ETF') {
        return mergeTickerStyle(style, {
            trendPersistence: 0.38,
            idioShockMult: 0.85,
            jumpProb: 0.0018,
            jumpScale: 1.9,
            meanReversionMult: 1.08,
            spreadMult: 0.82,
            factorLoadings: { riskOn: 0.44, rates: -0.12, usd: -0.05, vol: -0.12 },
        });
    }
    if (definition.class === 'Crypto') {
        return mergeTickerStyle(style, {
            trendPersistence: 0.66,
            idioShockMult: 1.45,
            jumpProb: 0.0068,
            jumpScale: 2.85,
            meanReversionMult: 0.7,
            spreadMult: 1.32,
            volumeBase: 120,
            volumeJitter: 900,
            volumeMoveMult: 360,
            factorLoadings: { crypto: 1.65, riskOn: 0.85, usd: -0.45, vol: -0.38 },
        });
    }
    if (definition.class === 'Forex') {
        return mergeTickerStyle(style, {
            trendPersistence: 0.28,
            idioShockMult: 0.8,
            jumpProb: 0.0012,
            jumpScale: 1.6,
            meanReversionMult: 1.55,
            dynamicAnchorWeight: 0.22,
            spreadMult: 0.62,
            volumeBase: 70,
            volumeJitter: 360,
            volumeMoveMult: 180,
            factorLoadings: { usd: 0.7, rates: 0.28, riskOn: 0.08, vol: 0.05 },
        });
    }
    return style;
}

function getTickerStyle(ticker, definition) {
    const classStyle = buildClassStyle(definition);
    const override = TICKER_STYLE_OVERRIDES[ticker] || {};
    return mergeTickerStyle(classStyle, override);
}

const TICKER_STYLES = Object.fromEntries(
    TICKER_LIST.map((ticker) => [ticker, getTickerStyle(ticker, TICKERS[ticker])])
);

function evolveFactor(name, {
    persistence,
    noiseScale,
    jumpProb = 0,
    jumpScale = 0,
    clampAbs = 0.004,
}) {
    const prior = marketFactors[name] || 0;
    let next = (prior * persistence) + (gaussianRandom() * noiseScale);
    if (jumpProb > 0 && Math.random() < jumpProb) {
        next += gaussianRandom() * jumpScale;
    }
    marketFactors[name] = clamp(next, -clampAbs, clampAbs);
}

function updateMarketFactors(now) {
    evolveFactor('riskOn', { persistence: 0.97, noiseScale: 0.00008, jumpProb: 0.002, jumpScale: 0.00055, clampAbs: 0.0035 });
    evolveFactor('usd', { persistence: 0.982, noiseScale: 0.00005, jumpProb: 0.0012, jumpScale: 0.00025, clampAbs: 0.0022 });
    evolveFactor('rates', { persistence: 0.985, noiseScale: 0.000045, jumpProb: 0.001, jumpScale: 0.0002, clampAbs: 0.0018 });
    evolveFactor('energy', { persistence: 0.973, noiseScale: 0.00009, jumpProb: 0.0025, jumpScale: 0.0006, clampAbs: 0.004 });
    evolveFactor('metals', { persistence: 0.978, noiseScale: 0.000075, jumpProb: 0.0018, jumpScale: 0.00045, clampAbs: 0.0034 });
    evolveFactor('crypto', { persistence: 0.963, noiseScale: 0.00013, jumpProb: 0.0038, jumpScale: 0.0009, clampAbs: 0.0056 });
    evolveFactor('vol', { persistence: 0.955, noiseScale: 0.0001, jumpProb: 0.0028, jumpScale: 0.0008, clampAbs: 0.005 });

    // Correlated spillovers to keep cross-asset structure coherent.
    marketFactors.crypto = clamp(marketFactors.crypto + (marketFactors.riskOn * 0.035), -0.0056, 0.0056);
    marketFactors.energy = clamp(marketFactors.energy + (marketFactors.usd * -0.018), -0.004, 0.004);
    marketFactors.metals = clamp(marketFactors.metals + (marketFactors.usd * -0.02), -0.0034, 0.0034);
    marketFactors.vol = clamp(marketFactors.vol + (marketFactors.riskOn * -0.04), -0.005, 0.005);

    // Session effects: stronger risk transfer during US hours, stronger FX during London overlap.
    const hour = new Date(now).getUTCHours();
    if (hour >= 13 && hour <= 20) {
        marketFactors.riskOn = clamp(marketFactors.riskOn * 1.04, -0.0035, 0.0035);
        marketFactors.vol = clamp(marketFactors.vol * 1.06, -0.005, 0.005);
    }
    if (hour >= 7 && hour <= 16) {
        marketFactors.usd = clamp(marketFactors.usd * 1.03, -0.0022, 0.0022);
        marketFactors.rates = clamp(marketFactors.rates * 1.03, -0.0018, 0.0018);
    }
}

function getSessionVolMultiplier(definition, now) {
    const date = new Date(now);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();

    if (definition.class === 'Forex') {
        if (hour >= 7 && hour <= 16) return 1.18;
        if (hour >= 0 && hour <= 3) return 0.82;
        return 0.95;
    }
    if (definition.class === 'Crypto') {
        return day === 0 || day === 6 ? 1.14 : 1.03;
    }
    if (definition.class === 'Commodity') {
        return (hour >= 12 && hour <= 20) ? 1.12 : 0.9;
    }
    if (definition.class === 'Stock' || definition.class === 'Future' || definition.class === 'ETF') {
        return (hour >= 13 && hour <= 20) ? 1.2 : 0.84;
    }
    return 1.0;
}

function getFactorShock(style) {
    const loadings = style.factorLoadings || {};
    let sum = 0;
    for (const name of MARKET_FACTOR_NAMES) {
        sum += (marketFactors[name] || 0) * (loadings[name] || 0);
    }
    return sum;
}

// ─── Price State (hot in-memory for ultra low latency) ─────────────────────────
const prices = {};          // ticker → { price, bid, ask, open, high, low, prevClose, volume, volatility }
const orderFlowImpact = {}; // ticker → accumulated impact from user orders
const candleBuffers = {};   // ticker → { '1m': currentCandle, '5m': ..., ... }

const INTERVALS = {
    '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400
};

let tickCount = 0;
let newsCallback = null;  // set by wsServer to broadcast news
let tickCallback = null;  // set by wsServer to broadcast ticks
let paused = false;
let tickInFlight = false;
let lastDbWriteErrorLogAt = 0;
let nextRegimeTransitionAt = 0;
let forcedEventShockUntil = 0;
let currentSessionDayKey = null;
let currentRegime = {
    ...REGIME_PROFILES.normal,
    id: null,
    started_at: Date.now(),
    ended_at: null,
};

// ─── Gaussian random via Box-Muller ────────────────────────────────────────────
function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function getUtcDayKey(ts = Date.now()) {
    const d = new Date(ts);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function rolloverSession(now = Date.now()) {
    const dayKey = getUtcDayKey(now);
    if (!currentSessionDayKey) {
        currentSessionDayKey = dayKey;
        return;
    }
    if (dayKey === currentSessionDayKey) return;

    for (const ticker of TICKER_LIST) {
        const state = prices[ticker];
        if (!state) continue;
        const price = Number(state.price || 0);
        if (!Number.isFinite(price) || price <= 0) continue;
        state.prevClose = price;
        state.open = price;
        state.high = price;
        state.low = price;
        state.volume = 0;
    }
    currentSessionDayKey = dayKey;
}

// ─── Initialize prices ────────────────────────────────────────────────────────
async function initPrices() {
    // Try to restore from DB
    let saved = [];
    try {
        saved = await stmts.getAllPriceStates.all();
    } catch (error) {
        if (!isDbUnavailableError(error)) throw error;
        logDbWriteError('[Engine] Price state restore failed', error);
    }
    const savedMap = {};
    for (const s of saved) savedMap[s.ticker] = s;

    const now = Date.now();
    currentSessionDayKey = getUtcDayKey(now);
    for (const ticker of TICKER_LIST) {
        const def = TICKERS[ticker];
        const volRange = getVolatilityRange(def);
        const priceBounds = getPriceBounds(def);
        const s = savedMap[ticker];
        if (s) {
            const clampedPrice = clamp(s.price, priceBounds.minPrice, priceBounds.maxPrice);
            const spread = clampedPrice * volRange.baseVolatility * 0.04;
            prices[ticker] = {
                price: clampedPrice,
                bid: clamp(s.bid || clampedPrice - spread / 2, priceBounds.minPrice, priceBounds.maxPrice),
                ask: clamp(s.ask || clampedPrice + spread / 2, priceBounds.minPrice, priceBounds.maxPrice),
                open: clamp(s.open || clampedPrice, priceBounds.minPrice, priceBounds.maxPrice),
                high: clamp(s.high || clampedPrice, priceBounds.minPrice, priceBounds.maxPrice),
                low: clamp(s.low || clampedPrice, priceBounds.minPrice, priceBounds.maxPrice),
                prevClose: clamp(s.prev_close || clampedPrice, priceBounds.minPrice, priceBounds.maxPrice),
                volume: s.volume,
                volatility: clamp(s.volatility, volRange.minVolatility, volRange.maxVolatility),
                anchorPrice: clampedPrice,
                lastReturn: 0,
            };
            const restoredPrevClose = Number(prices[ticker].prevClose || clampedPrice);
            const restoredGapPct = restoredPrevClose > 0
                ? Math.abs((clampedPrice - restoredPrevClose) / restoredPrevClose)
                : 0;
            const savedDayKey = getUtcDayKey(Number(s.updated_at || now));
            if (savedDayKey !== currentSessionDayKey || restoredGapPct >= 0.35) {
                prices[ticker].prevClose = clampedPrice;
                prices[ticker].open = clampedPrice;
                prices[ticker].high = clampedPrice;
                prices[ticker].low = clampedPrice;
                prices[ticker].volume = 0;
            }
        } else {
            // Fresh start — small random offset from base
            const startPrice = def.basePrice * (1 + (Math.random() - 0.5) * 0.02);
            const spread = startPrice * volRange.baseVolatility * 0.06;
            prices[ticker] = {
                price: startPrice,
                bid: startPrice - spread / 2,
                ask: startPrice + spread / 2,
                open: startPrice,
                high: startPrice,
                low: startPrice,
                prevClose: startPrice,
                volume: 0,
                volatility: volRange.baseVolatility,
                anchorPrice: startPrice,
                lastReturn: 0,
            };
        }
        orderFlowImpact[ticker] = 0;
        initCandleBuffers(ticker, now);
    }
}

function initCandleBuffers(ticker, now) {
    candleBuffers[ticker] = {};
    const p = prices[ticker].price;
    for (const [interval, secs] of Object.entries(INTERVALS)) {
        const openTime = Math.floor(now / (secs * 1000)) * secs * 1000;
        candleBuffers[ticker][interval] = {
            openTime, open: p, high: p, low: p, close: p, volume: 0
        };
    }
}

function getRegimeProfile(regimeName) {
    return REGIME_PROFILES[regimeName] || REGIME_PROFILES.normal;
}

function getCurrentRegime() {
    return { ...currentRegime };
}

function scheduleNextRegimeTransition(now = Date.now()) {
    const jitter = 0.8 + (Math.random() * 0.4);
    nextRegimeTransitionAt = now + Math.floor(MARKET_REGIME_REVIEW_INTERVAL_MS * jitter);
}

function pickScheduledRegime() {
    const roll = Math.random();
    if (roll < 0.62) return 'normal';
    if (roll < 0.8) return 'tight_liquidity';
    if (roll < 0.96) return 'high_volatility';
    return 'event_shock';
}

async function setMarketRegime(regimeName, now = Date.now()) {
    const profile = getRegimeProfile(regimeName);
    const hasChanged = currentRegime.regime !== profile.regime;
    if (!hasChanged) return currentRegime;

    currentRegime = {
        ...profile,
        id: uuid(),
        started_at: now,
        ended_at: null,
    };

    if (!MARKET_REGIME_ENABLED) return currentRegime;

    try {
        await stmts.closeActiveMarketRegime.run(now);
        await stmts.insertMarketRegime.run(
            currentRegime.id,
            currentRegime.regime,
            currentRegime.liquidity_mult,
            currentRegime.vol_mult,
            currentRegime.news_mult,
            currentRegime.borrow_mult,
            now,
            null
        );
    } catch (error) {
        if (!isDbUnavailableError(error)) {
            console.error('[Engine] Market regime persist failed:', error.message);
        }
    }
    return currentRegime;
}

async function initMarketRegime(now = Date.now()) {
    if (!MARKET_REGIME_ENABLED) {
        currentRegime = {
            ...REGIME_PROFILES.normal,
            id: 'legacy',
            started_at: now,
            ended_at: null,
        };
        scheduleNextRegimeTransition(now);
        return;
    }

    try {
        const active = await stmts.getActiveMarketRegime.get();
        if (active) {
            currentRegime = {
                regime: active.regime,
                liquidity_mult: Number(active.liquidity_mult || 1),
                vol_mult: Number(active.vol_mult || 1),
                news_mult: Number(active.news_mult || 1),
                borrow_mult: Number(active.borrow_mult || 1),
                id: active.id,
                started_at: Number(active.started_at || now),
                ended_at: active.ended_at ? Number(active.ended_at) : null,
            };
            scheduleNextRegimeTransition(now);
            return;
        }
    } catch (error) {
        if (!isDbUnavailableError(error)) {
            console.error('[Engine] Failed to restore market regime:', error.message);
        }
    }

    await setMarketRegime('normal', now);
    scheduleNextRegimeTransition(now);
}

async function maybeTransitionRegime(now = Date.now()) {
    if (!MARKET_REGIME_ENABLED) return currentRegime;

    if (forcedEventShockUntil > now) {
        if (currentRegime.regime !== 'event_shock') {
            await setMarketRegime('event_shock', now);
        }
        return currentRegime;
    }

    if (currentRegime.regime === 'event_shock' && forcedEventShockUntil <= now) {
        await setMarketRegime('normal', now);
        scheduleNextRegimeTransition(now);
        return currentRegime;
    }

    if (nextRegimeTransitionAt > now) return currentRegime;

    const nextRegime = pickScheduledRegime();
    await setMarketRegime(nextRegime, now);
    scheduleNextRegimeTransition(now);
    return currentRegime;
}

async function triggerEventShock(durationMs = MARKET_EVENT_SHOCK_DURATION_MS) {
    const now = Date.now();
    forcedEventShockUntil = Math.max(forcedEventShockUntil, now + Math.max(30_000, Number(durationMs) || MARKET_EVENT_SHOCK_DURATION_MS));
    if (!MARKET_REGIME_ENABLED) return;
    await setMarketRegime('event_shock', now);
}

// ─── Core Tick Function ────────────────────────────────────────────────────────
function logDbWriteError(prefix, error) {
    const now = Date.now();
    if (now - lastDbWriteErrorLogAt < 15000) return;
    lastDbWriteErrorLogAt = now;
    console.error(`${prefix}:`, error.message);
}

async function tick() {
    if (paused) return [];

    const now = Date.now();
    rolloverSession(now);
    tickCount++;
    const tickData = [];
    const candlesToSave = [];
    const priceStates = [];
    updateMarketFactors(now);
    await maybeTransitionRegime(now);
    const regime = getCurrentRegime();

    for (const ticker of TICKER_LIST) {
        const def = TICKERS[ticker];
        const style = TICKER_STYLES[ticker] || DEFAULT_TICKER_STYLE;
        const volRange = getVolatilityRange(def);
        const priceBounds = getPriceBounds(def, state.anchorPrice);
        const state = prices[ticker];
        const oldPrice = state.price;
        const sessionVolMult = getSessionVolMultiplier(def, now);
        const factorShock = getFactorShock(style);
        const priorReturn = Number(state.lastReturn || 0);
        const anchorPrice = Number(state.anchorPrice || def.basePrice);
        const maxTickMovePct = getMaxTickMovePct(def) * (style.maxTickMoveMult || 1);

        // ── GARCH volatility update ──
        const returnVal = oldPrice > 0 ? Math.log(state.price / (state.prevClose || state.price)) : 0;
        const omega = volRange.baseVolatility * volRange.baseVolatility * 0.03;
        const alpha = MARKET_GARCH_ALPHA;
        const beta = MARKET_GARCH_BETA;
        const factorVariance = Math.abs(factorShock) * state.volatility * (style.volOfVol || 1) * 0.05;
        state.volatility = Math.sqrt(
            omega + alpha * returnVal * returnVal + beta * state.volatility * state.volatility + factorVariance
        );
        const sessionVolScale = 1 + ((sessionVolMult - 1) * 0.35);
        state.volatility *= sessionVolScale;
        state.volatility *= regime.vol_mult;
        state.volatility = clamp(state.volatility, volRange.minVolatility, volRange.maxVolatility);

        // ── Factor + regime + idiosyncratic move ──
        const drift = def.drift;
        const trendCarry = priorReturn * (style.trendPersistence || 0);
        const idioShock = gaussianRandom() * state.volatility * MARKET_SHOCK_MULTIPLIER * (style.idioShockMult || 1);
        const jumpShock = Math.random() < (style.jumpProb || 0)
            ? gaussianRandom() * state.volatility * (style.jumpScale || 1)
            : 0;
        let rawReturn = drift + factorShock + trendCarry + idioShock + jumpShock;
        rawReturn = clamp(rawReturn, -maxTickMovePct, maxTickMovePct);
        let newPrice = oldPrice * Math.exp(rawReturn);

        // ── Mean reversion ──
        const updatedAnchor = anchorPrice + ((oldPrice - anchorPrice) * (style.anchorFollow || 0));
        state.anchorPrice = updatedAnchor;
        const targetAnchor = (def.basePrice * (1 - (style.dynamicAnchorWeight || 0))) + (updatedAnchor * (style.dynamicAnchorWeight || 0));
        const deviation = targetAnchor > 0 ? (newPrice - targetAnchor) / targetAnchor : 0;
        newPrice -= deviation * def.meanRev * MARKET_MEAN_REVERSION_MULTIPLIER * (style.meanReversionMult || 1) * oldPrice;

        // ── Order flow impact ──
        if (orderFlowImpact[ticker] !== 0) {
            const maxImpactAbs = oldPrice * MARKET_MAX_ORDER_FLOW_MOVE_PCT * getRiskMultiplier(def);
            const appliedImpact = clamp(orderFlowImpact[ticker], -maxImpactAbs, maxImpactAbs);
            newPrice += appliedImpact;
            orderFlowImpact[ticker] *= MARKET_ORDER_FLOW_DECAY;
            if (Math.abs(orderFlowImpact[ticker]) < oldPrice * 0.00005) orderFlowImpact[ticker] = 0;
        }

        // Hard movement/range guardrails to prevent crash-and-pump exploits.
        const maxTickMove = oldPrice * maxTickMovePct;
        newPrice = clamp(newPrice, oldPrice - maxTickMove, oldPrice + maxTickMove);
        newPrice = clamp(newPrice, priceBounds.minPrice, priceBounds.maxPrice);
        state.lastReturn = oldPrice > 0 ? Math.log(newPrice / oldPrice) : 0;

        // ── Update spread ──
        const spread = newPrice
            * state.volatility
            * 0.05
            * MARKET_SPREAD_MULTIPLIER
            * (style.spreadMult || 1)
            * regime.liquidity_mult;
        state.price = +newPrice.toFixed(getDecimals(ticker));
        state.bid = +(newPrice - spread / 2).toFixed(getDecimals(ticker));
        state.ask = +(newPrice + spread / 2).toFixed(getDecimals(ticker));
        state.high = Math.max(state.high, state.price);
        state.low = Math.min(state.low, state.price);

        // ── Volume simulation ──
        const absMovePct = oldPrice > 0 ? Math.abs(newPrice - oldPrice) / oldPrice : 0;
        const baseVolume = (style.volumeBase || 80) + (Math.random() * (style.volumeJitter || 500));
        const moveIntensity = 1 + (absMovePct * (style.volumeMoveMult || 220));
        const volIntensity = 1 + (state.volatility * (style.volumeVolMult || 4));
        const tickVolume = Math.max(1, Math.floor(baseVolume * moveIntensity * volIntensity * sessionVolMult));
        state.volume += tickVolume;

        // ── Update candle buffers ──
        for (const [interval, secs] of Object.entries(INTERVALS)) {
            const buf = candleBuffers[ticker][interval];
            const intervalMs = secs * 1000;
            const expectedOpen = Math.floor(now / intervalMs) * intervalMs;

            if (expectedOpen > buf.openTime) {
                // Save completed candle
                candlesToSave.push({
                    ticker, interval, openTime: buf.openTime,
                    open: buf.open, high: buf.high, low: buf.low, close: buf.close, volume: buf.volume
                });
                // Start new candle
                buf.openTime = expectedOpen;
                buf.open = state.price;
                buf.high = state.price;
                buf.low = state.price;
                buf.close = state.price;
                buf.volume = tickVolume;
            } else {
                buf.high = Math.max(buf.high, state.price);
                buf.low = Math.min(buf.low, state.price);
                buf.close = state.price;
                buf.volume += tickVolume;
            }
        }

        // Build tick payload
        const change = state.price - state.prevClose;
        const changePct = state.prevClose > 0 ? (change / state.prevClose) * 100 : 0;
        tickData.push({
            type: 'tick',
            ticker,
            price: state.price,
            bid: state.bid,
            ask: state.ask,
            open: state.open,
            high: state.high,
            low: state.low,
            prevClose: state.prevClose,
            volume: state.volume,
            change: +change.toFixed(getDecimals(ticker)),
            changePct: +changePct.toFixed(2),
            volatility: +state.volatility.toFixed(6),
            regime: regime.regime,
            timestamp: now
        });

        priceStates.push({
            ticker, price: state.price, bid: state.bid, ask: state.ask,
            open: state.open, high: state.high, low: state.low,
            prevClose: state.prevClose, volume: state.volume,
            volatility: state.volatility, updatedAt: now
        });
    }

    // Batch save to DB every 5 ticks for performance
    if (tickCount % 5 === 0) {
        try {
            if (candlesToSave.length > 0) await batchUpsertCandles(candlesToSave);
            await batchUpsertPriceStates(priceStates);
        } catch (e) {
            if (isDbUnavailableError(e)) logDbWriteError('[Engine] DB save error', e);
            else console.error('[Engine] DB save error:', e.message);
        }
    } else if (candlesToSave.length > 0) {
        try {
            await batchUpsertCandles(candlesToSave);
        } catch (e) {
            if (isDbUnavailableError(e)) logDbWriteError('[Engine] Candle save error', e);
            else console.error('[Engine] Candle save error:', e.message);
        }
    }

    // Broadcast ticks
    if (tickCallback) {
        try {
            tickCallback(tickData);
        } catch (error) {
            console.error('[Engine] Tick callback error:', error.message);
        }
    }

    return tickData;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function getDecimals(ticker) {
    const cls = TICKERS[ticker]?.class;
    if (cls === 'Forex') return 4;
    if (cls === 'Commodity' && TICKERS[ticker].basePrice < 10) return 3;
    if (TICKERS[ticker]?.basePrice > 1000) return 2;
    return 2;
}

function addOrderFlowImpact(ticker, side, notional) {
    const def = TICKERS[ticker];
    if (!def) return;
    const state = prices[ticker];
    const referencePrice = state?.price || def.basePrice;
    const risk = getRiskMultiplier(def);

    const liquidityNotional = Math.max(def.basePrice * 2_500_000, 20_000_000) * risk;
    const rawImpactPct = (notional / liquidityNotional) * MARKET_ORDER_FLOW_MULTIPLIER * 0.01;
    const maxImpactPct = MARKET_MAX_ORDER_FLOW_MOVE_PCT * risk;
    const boundedImpactPct = clamp(rawImpactPct, -maxImpactPct, maxImpactPct);
    const signedImpact = referencePrice * boundedImpactPct * (side === 'buy' ? 1 : -1);

    const accumulatorCap = referencePrice * maxImpactPct * 2;
    orderFlowImpact[ticker] = clamp((orderFlowImpact[ticker] || 0) + signedImpact, -accumulatorCap, accumulatorCap);
}

function applyNewsShock(ticker, impactPct) {
    const state = prices[ticker];
    if (!state) return;
    const def = TICKERS[ticker];
    const boundedImpactPct = clamp(impactPct, -getMaxNewsMovePct(def), getMaxNewsMovePct(def));
    const bounds = getPriceBounds(def, state.anchorPrice);
    state.price = clamp(state.price * (1 + boundedImpactPct), bounds.minPrice, bounds.maxPrice);
    // Spike volatility
    const volRange = getVolatilityRange(def);
    state.volatility = Math.min(state.volatility * MARKET_NEWS_VOL_SPIKE_MULTIPLIER, volRange.maxVolatility);

    if (Math.abs(boundedImpactPct) >= 0.015) {
        triggerEventShock().catch((error) => {
            if (!isDbUnavailableError(error)) {
                console.error('[Engine] Failed to trigger event shock:', error.message);
            }
        });
    }
}

function getPrice(ticker) {
    return prices[ticker] || null;
}

function getAllPrices() {
    return { ...prices };
}

function getTickerDef(ticker) {
    return TICKERS[ticker] || null;
}

function getAllTickerDefs() {
    return TICKERS;
}

function getCurrentCandle(ticker, interval) {
    return candleBuffers[ticker]?.[interval] || null;
}

function setTickCallback(cb) { tickCallback = cb; }
function setNewsCallback(cb) { newsCallback = cb; }
function getNewsCallback() { return newsCallback; }

// ─── Start Engine ──────────────────────────────────────────────────────────────
let engineInterval = null;

async function start() {
    await initPrices();
    await initMarketRegime();
    console.log(`[Engine] Initialized ${TICKER_LIST.length} tickers`);
    engineInterval = setInterval(() => {
        if (paused || tickInFlight) return;
        tickInFlight = true;
        tick()
            .catch((error) => {
                if (isDbUnavailableError(error)) logDbWriteError('[Engine] Tick DB error', error);
                else console.error('[Engine] Tick error:', error.message);
            })
            .finally(() => {
                tickInFlight = false;
            });
    }, 1000);
    console.log('[Engine] Running — 1 second tick rate');
}

function pause(reason = 'db_unavailable') {
    if (paused) return;
    paused = true;
    console.warn(`[Engine] Paused background ticks (${reason})`);
}

function resume() {
    if (!paused) return;
    paused = false;
    console.log('[Engine] Resumed background ticks');
}

function isPaused() {
    return paused;
}

async function stop() {
    if (engineInterval) clearInterval(engineInterval);
    // Final save
    const priceStates = TICKER_LIST.map(ticker => {
        const s = prices[ticker];
        if (!s) return null;
        return {
            ticker, price: s.price, bid: s.bid, ask: s.ask,
            open: s.open, high: s.high, low: s.low,
            prevClose: s.prevClose, volume: s.volume,
            volatility: s.volatility, updatedAt: Date.now()
        };
    }).filter(Boolean);
    try {
        await batchUpsertPriceStates(priceStates);
    } catch (error) {
        if (!isDbUnavailableError(error)) {
            console.error('[Engine] Final state save failed:', error.message);
        }
    }
    if (MARKET_REGIME_ENABLED) {
        try {
            await stmts.closeActiveMarketRegime.run(Date.now());
        } catch (error) {
            if (!isDbUnavailableError(error)) {
                console.error('[Engine] Failed to close active market regime:', error.message);
            }
        }
    }
    console.log('[Engine] Stopped — final state saved');
}

module.exports = {
    TICKERS, TICKER_LIST, INTERVALS,
    start, stop, tick,
    pause, resume, isPaused,
    getPrice, getAllPrices, getTickerDef, getAllTickerDefs,
    getCurrentCandle, addOrderFlowImpact, applyNewsShock,
    getCurrentRegime, triggerEventShock,
    setTickCallback, setNewsCallback, getNewsCallback,
    getDecimals
};
