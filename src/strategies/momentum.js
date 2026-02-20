const { stmts } = require('../db');

/**
 * Momentum Strategy
 * 
 * Calculates momentum as rate of change over N periods
 * BUY when momentum crosses above 0 (positive momentum)
 * SELL when momentum crosses below 0 (negative momentum)
 */

/**
 * Calculate momentum (rate of change)
 * @param {number} currentPrice - Current price
 * @param {number} pastPrice - Price N periods ago
 * @returns {number} Momentum value
 */
function calculateMomentum(currentPrice, pastPrice) {
    if (!pastPrice || pastPrice === 0) return 0;
    return ((currentPrice - pastPrice) / pastPrice) * 100;
}

/**
 * Fetch recent candle data from database
 * @param {string} ticker - The ticker symbol
 * @param {string} interval - Candle interval (e.g., '1m', '5m', '1h')
 * @param {number} limit - Number of candles to fetch
 * @returns {Promise<Object[]>} Array of candle objects
 */
async function fetchCandles(ticker, interval, limit) {
    const candles = await stmts.getCandles.all(ticker, interval, limit);
    return candles.reverse();
}

/**
 * Generate trade signal based on momentum crossover
 * @param {number} currentMomentum - Current momentum value
 * @param {number} prevMomentum - Previous momentum value
 * @returns {string} Signal: 'buy', 'sell', or 'hold'
 */
function generateSignal(currentMomentum, prevMomentum) {
    if (prevMomentum <= 0 && currentMomentum > 0) {
        return 'buy';
    }
    if (prevMomentum >= 0 && currentMomentum < 0) {
        return 'sell';
    }
    return 'hold';
}

/**
 * Main strategy function - can be called by strategy runner
 * 
 * @param {Object} config - Strategy configuration
 * @param {string} config.ticker - Ticker symbol to trade
 * @param {number} config.period - Lookback period for momentum (default: 14)
 * @param {number} config.positionSize - Position size for trades (default: 100)
 * @param {string} config.interval - Candle interval (default: '5m')
 * @returns {Promise<Object>} Signal result with trade details
 */
async function momentumStrategy(config) {
    const {
        ticker,
        period = 14,
        positionSize = 100,
        interval = '5m'
    } = config;

    if (!ticker) {
        throw new Error('Ticker is required');
    }

    const fetchLimit = period + 2;
    const candles = await fetchCandles(ticker, interval, fetchLimit);

    if (!candles || candles.length < period + 1) {
        return {
            ticker,
            signal: 'hold',
            reason: 'Insufficient candle data',
            data: {
                candlesAvailable: candles?.length || 0,
                periodRequired: period + 1
            }
        };
    }

    const closePrices = candles.map(c => parseFloat(c.close));
    const currentPrice = closePrices[closePrices.length - 1];
    const prevPrice = closePrices[closePrices.length - 2];

    const currentMomentum = calculateMomentum(
        currentPrice,
        closePrices[closePrices.length - 1 - period]
    );
    const prevMomentum = calculateMomentum(
        prevPrice,
        closePrices[closePrices.length - 2 - period]
    );

    const signal = generateSignal(currentMomentum, prevMomentum);

    let reason;
    if (signal === 'buy') {
        reason = `Momentum crossed above 0 (${prevMomentum.toFixed(2)} → ${currentMomentum.toFixed(2)}) - bullish`;
    } else if (signal === 'sell') {
        reason = `Momentum crossed below 0 (${prevMomentum.toFixed(2)} → ${currentMomentum.toFixed(2)}) - bearish`;
    } else {
        const trend = currentMomentum > 0 ? 'positive' : 'negative';
        reason = `Momentum at ${currentMomentum.toFixed(2)} (${trend}) - no crossover`;
    }

    return {
        ticker,
        signal,
        reason,
        positionSize: signal !== 'hold' ? positionSize : 0,
        data: {
            currentPrice,
            interval,
            momentum: {
                current: +currentMomentum.toFixed(4),
                previous: +prevMomentum.toFixed(4)
            },
            config: {
                period,
                positionSize
            }
        }
    };
}

module.exports = {
    momentumStrategy,
    calculateMomentum,
    fetchCandles,
    generateSignal
};
