const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError } = require('./db');
const engine = require('./engine');

// ─── News Templates ────────────────────────────────────────────────────────────
const TEMPLATES = {
    earnings_beat: {
        type: 'earnings',
        severity: 'high',
        headline: (t) => `${t.name} Beats Q${q()} Earnings Estimates`,
        body: (t) => `${t.name} reported EPS of $${(Math.random() * 3 + 1).toFixed(2)}, beating analyst estimates by ${(Math.random() * 20 + 5).toFixed(0)}%. Revenue grew ${(Math.random() * 15 + 3).toFixed(0)}% YoY.`,
        impactRange: [0.03, 0.08],
    },
    earnings_miss: {
        type: 'earnings',
        severity: 'high',
        headline: (t) => `${t.name} Misses Q${q()} Earnings, Cuts Guidance`,
        body: (t) => `${t.name} reported Q${q()} EPS of $${(Math.random() * 1 + 0.2).toFixed(2)}, missing estimates by ${(Math.random() * 25 + 10).toFixed(0)}%. Management lowered full-year guidance.`,
        impactRange: [-0.08, -0.03],
    },
    product_launch: {
        type: 'product',
        severity: 'normal',
        headline: (t) => `${t.name} Announces Revolutionary New Product Line`,
        body: (t) => `${t.name} unveiled its next-generation product at today's press event, targeting a $${(Math.random() * 50 + 10).toFixed(0)}B addressable market.`,
        impactRange: [0.02, 0.05],
    },
    ceo_departure: {
        type: 'corporate',
        severity: 'high',
        headline: (t) => `Breaking: ${t.name} CEO Steps Down Effective Immediately`,
        body: (t) => `The board of ${t.name} announced the sudden departure of the CEO, citing "personal reasons." An interim CEO has been appointed.`,
        impactRange: [-0.06, -0.02],
    },
    fda_approval: {
        type: 'regulatory',
        severity: 'high',
        headline: (t) => `FDA Grants Approval for ${t.name} Flagship Drug`,
        body: (t) => `${t.name} received FDA approval for its lead compound, opening a potential $${(Math.random() * 20 + 5).toFixed(0)}B market opportunity.`,
        impactRange: [0.08, 0.20],
    },
    fda_rejection: {
        type: 'regulatory',
        severity: 'high',
        headline: (t) => `FDA Rejects ${t.name} Drug Application — Back to Phase 2`,
        body: (t) => `The FDA issued a Complete Response Letter for ${t.name}'s lead drug candidate, requesting additional clinical data.`,
        impactRange: [-0.20, -0.08],
    },
    rate_hike: {
        type: 'macro',
        severity: 'high',
        headline: () => `Federal Reserve Raises Interest Rates by ${(Math.random() * 0.5 + 0.25).toFixed(2)}%`,
        body: () => `The Fed raised rates citing persistent inflation. Markets anticipate additional tightening in the coming quarters.`,
        impactRange: [-0.03, -0.01],
        global: true,
    },
    rate_cut: {
        type: 'macro',
        severity: 'high',
        headline: () => `Federal Reserve Cuts Rates by ${(Math.random() * 0.5 + 0.25).toFixed(2)}% — Markets Rally`,
        body: () => `The Fed surprised markets with a rate cut, citing economic slowdown. Growth stocks surge on the news.`,
        impactRange: [0.01, 0.04],
        global: true,
    },
    geopolitical: {
        type: 'geopolitical',
        severity: 'high',
        headline: () => `Geopolitical Tensions Escalate — Energy Prices Spike`,
        body: () => `Rising tensions in a key oil-producing region have disrupted supply chains. Energy commodities see sharp moves.`,
        impactRange: [-0.04, 0.06],
        sectors: ['Energy', 'Metals'],
    },
    analyst_upgrade: {
        type: 'analyst',
        severity: 'normal',
        headline: (t) => `Major Bank Upgrades ${t.name} to "Strong Buy"`,
        body: (t) => `Analysts at a leading investment bank raised their price target on ${t.name} by ${(Math.random() * 30 + 10).toFixed(0)}%, citing improving fundamentals.`,
        impactRange: [0.02, 0.04],
    },
    analyst_downgrade: {
        type: 'analyst',
        severity: 'normal',
        headline: (t) => `${t.name} Downgraded to "Sell" — Concerns Over Growth`,
        body: (t) => `A top-tier research firm cut ${t.name} to underperform, warning of margin compression and slowing growth.`,
        impactRange: [-0.04, -0.02],
    },
    short_squeeze: {
        type: 'market',
        severity: 'high',
        headline: (t) => `Short Squeeze Alert: ${t.name} Surges on Heavy Volume`,
        body: (t) => `${t.name} is experiencing a massive short squeeze, with short interest at ${(Math.random() * 30 + 20).toFixed(0)}% of float. Retail traders pile in.`,
        impactRange: [0.10, 0.30],
    },
    sector_rotation: {
        type: 'macro',
        severity: 'normal',
        headline: () => `Sector Rotation: Institutions Shift to Defensive Names`,
        body: () => `Fund managers are moving capital from growth to value, increasing allocations to utilities, healthcare, and bonds.`,
        impactRange: [-0.02, 0.02],
        global: true,
    },
    crypto_regulation: {
        type: 'regulatory',
        severity: 'high',
        headline: () => `New Crypto Regulatory Framework Announced`,
        body: () => `The SEC unveiled a new regulatory framework for digital assets. Some view it as bullish clarity, others as a crackdown.`,
        impactRange: [-0.08, 0.08],
        sectors: ['Crypto'],
    },
    supply_chain: {
        type: 'supply',
        severity: 'normal',
        headline: (t) => `${t.name} Reports Supply Chain Disruption`,
        body: (t) => `${t.name} warned of production delays due to supply chain bottlenecks, potentially impacting next quarter revenue.`,
        impactRange: [-0.04, -0.01],
    },
    partnership: {
        type: 'corporate',
        severity: 'normal',
        headline: (t) => `${t.name} Announces Strategic Partnership`,
        body: (t) => `${t.name} entered into a multi-year strategic partnership expected to generate $${(Math.random() * 5 + 1).toFixed(1)}B in incremental revenue.`,
        impactRange: [0.02, 0.05],
    },
    meme_rally: {
        type: 'market',
        severity: 'normal',
        headline: (t) => `🚀 ${t.name} Trending on Social Media — Retail Buying Frenzy`,
        body: (t) => `${t.name} is the #1 trending ticker on social platforms. Volume is ${(Math.random() * 5 + 2).toFixed(0)}x the 20-day average.`,
        impactRange: [0.05, 0.15],
    },
    gdp_data: {
        type: 'macro',
        severity: 'normal',
        headline: () => `GDP Growth Comes In at ${(Math.random() * 3 + 0.5).toFixed(1)}% — ${Math.random() > 0.5 ? 'Above' : 'Below'} Expectations`,
        body: () => `The latest GDP reading signals ${Math.random() > 0.5 ? 'a resilient economy' : 'economic headwinds'}. Markets react as traders reassess rate expectations.`,
        impactRange: [-0.02, 0.02],
        global: true,
    },
    forex_intervention: {
        type: 'macro',
        severity: 'high',
        headline: () => `Central Bank Intervenes in Currency Markets`,
        body: () => `In a surprise move, a major central bank intervened to support its currency, triggering sharp moves across FX pairs.`,
        impactRange: [-0.03, 0.03],
        sectors: ['FX'],
    },
};

const TEMPLATE_KEYS = Object.keys(TEMPLATES);
function q() { return Math.floor(Math.random() * 4) + 1; }

// ─── News Engine ───────────────────────────────────────────────────────────────
let newsInterval = null;
let nextNewsTime = 0;
let paused = false;
let inFlight = false;
let lastDbErrorLogAt = 0;

function scheduleNext() {
    // Random 15–90 seconds (compressed time — in production these would be 15–90 minutes)
    nextNewsTime = Date.now() + (Math.random() * 75000 + 15000);
}

function logDbError(error) {
    const now = Date.now();
    if (now - lastDbErrorLogAt < 15000) return;
    lastDbErrorLogAt = now;
    console.error('[News] DB write failed:', error.message);
}

async function generateEvent() {
    const templateKey = TEMPLATE_KEYS[Math.floor(Math.random() * TEMPLATE_KEYS.length)];
    const template = TEMPLATES[templateKey];
    const now = Date.now();

    // Pick target ticker(s)
    let targetTicker = null;
    let affectedTickers = [];

    if (template.global) {
        // Affects all tickers to varying degrees
        targetTicker = null;
        affectedTickers = engine.TICKER_LIST;
    } else if (template.sectors) {
        // Affects a sector
        affectedTickers = engine.TICKER_LIST.filter(t => {
            const def = engine.getTickerDef(t);
            return template.sectors.includes(def.sector) || template.sectors.includes(def.class);
        });
        if (affectedTickers.length === 0) affectedTickers = [randomTicker()];
        targetTicker = affectedTickers[0];
    } else {
        targetTicker = randomTicker();
        affectedTickers = [targetTicker];
    }

    const tickerDef = targetTicker ? engine.getTickerDef(targetTicker) : { name: 'Market' };
    const headline = template.headline(tickerDef);
    const body = template.body(tickerDef);
    const [minImpact, maxImpact] = template.impactRange;
    const impact = minImpact + Math.random() * (maxImpact - minImpact);

    // Apply price shocks
    for (const t of affectedTickers) {
        let tickerImpact = impact;
        if (template.global) {
            // Global events have reduced per-ticker impact + randomization
            tickerImpact = impact * (0.3 + Math.random() * 0.7);
            // Safe haven tickers move opposite during crashes
            const def = engine.getTickerDef(t);
            if (impact < 0 && (def.sector === 'Bonds' || t === 'OGLD')) {
                tickerImpact = Math.abs(tickerImpact) * 0.5;
            }
            if (t === 'VIXF') {
                tickerImpact = -impact * 2; // VIX moves opposite to market
            }
        }
        engine.applyNewsShock(t, tickerImpact);
    }

    // Save to DB
    const eventId = uuid();
    const event = {
        id: eventId,
        ticker: targetTicker || 'MARKET',
        type: template.type,
        headline,
        body,
        priceImpact: +(impact * 100).toFixed(2),
        severity: template.severity,
        firedAt: now,
    };

    try {
        await stmts.insertNews.run(eventId, event.ticker, event.type, headline, body, event.priceImpact, event.severity, now);
    } catch (e) {
        if (isDbUnavailableError(e)) logDbError(e);
        else console.error('[News] Save error:', e.message);
    }

    // Broadcast
    const cb = engine.getNewsCallback();
    if (cb) cb(event);

    console.log(`[News] ${template.severity === 'high' ? '🔴' : '🔵'} ${headline}`);
    return event;
}

function randomTicker() {
    const tickers = engine.TICKER_LIST;
    return tickers[Math.floor(Math.random() * tickers.length)];
}

function start() {
    scheduleNext();
    newsInterval = setInterval(() => {
        if (paused || inFlight) return;
        if (Date.now() < nextNewsTime) return;
        inFlight = true;
        generateEvent()
            .catch((error) => {
                if (isDbUnavailableError(error)) logDbError(error);
                else console.error('[News] Event generation failed:', error.message);
            })
            .finally(() => {
                scheduleNext();
                inFlight = false;
            });
    }, 1000);
    console.log('[News] Engine started');
}

function pause(reason = 'db_unavailable') {
    if (paused) return;
    paused = true;
    console.warn(`[News] Paused generation (${reason})`);
}

function resume() {
    if (!paused) return;
    paused = false;
    scheduleNext();
    console.log('[News] Resumed generation');
}

function isPaused() {
    return paused;
}

function stop() {
    if (newsInterval) clearInterval(newsInterval);
}

module.exports = { start, stop, pause, resume, isPaused, generateEvent };
