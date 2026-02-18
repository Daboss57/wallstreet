const { v4: uuid } = require('uuid');
const { stmts, batchUpsertCandles, batchUpsertPriceStates } = require('./db');

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

const TICKER_LIST = Object.keys(TICKERS);

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

// ─── Gaussian random via Box-Muller ────────────────────────────────────────────
function gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ─── Initialize prices ────────────────────────────────────────────────────────
function initPrices() {
    // Try to restore from DB
    const saved = stmts.getAllPriceStates.all();
    const savedMap = {};
    for (const s of saved) savedMap[s.ticker] = s;

    const now = Date.now();
    for (const ticker of TICKER_LIST) {
        const def = TICKERS[ticker];
        const s = savedMap[ticker];
        if (s) {
            prices[ticker] = {
                price: s.price, bid: s.bid, ask: s.ask,
                open: s.open, high: s.high, low: s.low,
                prevClose: s.prev_close, volume: s.volume,
                volatility: s.volatility
            };
        } else {
            // Fresh start — small random offset from base
            const startPrice = def.basePrice * (1 + (Math.random() - 0.5) * 0.02);
            const spread = startPrice * def.volatility * 0.1;
            prices[ticker] = {
                price: startPrice,
                bid: startPrice - spread / 2,
                ask: startPrice + spread / 2,
                open: startPrice,
                high: startPrice,
                low: startPrice,
                prevClose: startPrice,
                volume: 0,
                volatility: def.volatility
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

// ─── Core Tick Function ────────────────────────────────────────────────────────
function tick() {
    const now = Date.now();
    tickCount++;
    const tickData = [];
    const candlesToSave = [];
    const priceStates = [];

    for (const ticker of TICKER_LIST) {
        const def = TICKERS[ticker];
        const state = prices[ticker];
        const oldPrice = state.price;

        // ── GARCH volatility update ──
        const returnVal = oldPrice > 0 ? Math.log(state.price / (state.prevClose || state.price)) : 0;
        const omega = def.volatility * def.volatility * 0.05;
        const alpha = 0.1;
        const beta = 0.85;
        state.volatility = Math.sqrt(
            omega + alpha * returnVal * returnVal + beta * state.volatility * state.volatility
        );
        // Clamp volatility
        const minVol = def.volatility * 0.3;
        const maxVol = def.volatility * 5.0;
        state.volatility = Math.max(minVol, Math.min(maxVol, state.volatility));

        // ── Random drift (GBM) ──
        const drift = def.drift;
        const shock = gaussianRandom() * state.volatility;
        let newPrice = oldPrice * Math.exp(drift + shock);

        // ── Mean reversion ──
        const deviation = (newPrice - def.basePrice) / def.basePrice;
        newPrice -= deviation * def.meanRev * oldPrice;

        // ── Order flow impact ──
        if (orderFlowImpact[ticker] !== 0) {
            newPrice += orderFlowImpact[ticker];
            orderFlowImpact[ticker] *= 0.5; // decay
            if (Math.abs(orderFlowImpact[ticker]) < 0.001) orderFlowImpact[ticker] = 0;
        }

        // Ensure price stays positive
        newPrice = Math.max(newPrice, oldPrice * 0.5, 0.01);

        // ── Update spread ──
        const spread = newPrice * state.volatility * 0.08;
        state.price = +newPrice.toFixed(getDecimals(ticker));
        state.bid = +(newPrice - spread / 2).toFixed(getDecimals(ticker));
        state.ask = +(newPrice + spread / 2).toFixed(getDecimals(ticker));
        state.high = Math.max(state.high, state.price);
        state.low = Math.min(state.low, state.price);

        // ── Volume simulation ──
        const tickVolume = Math.floor(Math.random() * 500 + 50) * (1 + state.volatility * 10);
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
            if (candlesToSave.length > 0) batchUpsertCandles(candlesToSave);
            batchUpsertPriceStates(priceStates);
        } catch (e) {
            console.error('DB save error:', e.message);
        }
    } else if (candlesToSave.length > 0) {
        try { batchUpsertCandles(candlesToSave); } catch (e) { console.error('Candle save error:', e.message); }
    }

    // Broadcast ticks
    if (tickCallback) tickCallback(tickData);

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
    const impact = (notional / (def.basePrice * 10000)) * def.basePrice * 0.001;
    orderFlowImpact[ticker] += side === 'buy' ? impact : -impact;
}

function applyNewsShock(ticker, impactPct) {
    const state = prices[ticker];
    if (!state) return;
    state.price *= (1 + impactPct);
    state.price = Math.max(state.price, 0.01);
    // Spike volatility
    state.volatility = Math.min(state.volatility * 2.5, TICKERS[ticker].volatility * 5);
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

function start() {
    initPrices();
    console.log(`[Engine] Initialized ${TICKER_LIST.length} tickers`);
    engineInterval = setInterval(tick, 1000);
    console.log('[Engine] Running — 1 second tick rate');
}

function stop() {
    if (engineInterval) clearInterval(engineInterval);
    // Final save
    const priceStates = TICKER_LIST.map(ticker => {
        const s = prices[ticker];
        return {
            ticker, price: s.price, bid: s.bid, ask: s.ask,
            open: s.open, high: s.high, low: s.low,
            prevClose: s.prevClose, volume: s.volume,
            volatility: s.volatility, updatedAt: Date.now()
        };
    });
    batchUpsertPriceStates(priceStates);
    console.log('[Engine] Stopped — final state saved');
}

module.exports = {
    TICKERS, TICKER_LIST, INTERVALS,
    start, stop, tick,
    getPrice, getAllPrices, getTickerDef, getAllTickerDefs,
    getCurrentCandle, addOrderFlowImpact, applyNewsShock,
    setTickCallback, setNewsCallback, getNewsCallback,
    getDecimals
};
