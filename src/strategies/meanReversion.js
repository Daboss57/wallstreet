const { stmts } = require('../db');

/**
 * Mean Reversion Strategy
 * 
 * Buys when price drops below lower Bollinger Band
 * Sells when price rises above upper Bollinger Band
 * Uses configurable lookback period and standard deviation multiplier
 */

/**
 * Calculate Simple Moving Average
 * @param {number[]} prices - Array of closing prices
 * @returns {number} SMA value
 */
function calculateSMA(prices) {
    if (!prices || prices.length === 0) return 0;
    return prices.reduce((sum, p) => sum + p, 0) / prices.length;
}

/**
 * Calculate Standard Deviation
 * @param {number[]} prices - Array of closing prices
 * @param {number} mean - The mean value
 * @returns {number} Standard deviation
 */
function calculateStdDev(prices, mean) {
    if (!prices || prices.length === 0) return 0;
    const squaredDiffs = prices.map(p => Math.pow(p - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, v) => sum + v, 0) / prices.length;
    return Math.sqrt(avgSquaredDiff);
}

/**
 * Calculate Bollinger Bands
 * @param {number[]} prices - Array of closing prices (oldest first)
 * @param {number} period - Lookback period for SMA
 * @param {number} stdDevMultiplier - Multiplier for standard deviation
 * @returns {Object} Bollinger Bands { upper, middle, lower }
 */
function calculateBollingerBands(prices, period, stdDevMultiplier) {
    if (!prices || prices.length < period) {
        return null;
    }

    // Get the most recent 'period' prices
    const recentPrices = prices.slice(-period);
    const middle = calculateSMA(recentPrices);
    const stdDev = calculateStdDev(recentPrices, middle);

    return {
        upper: middle + (stdDev * stdDevMultiplier),
        middle,
        lower: middle - (stdDev * stdDevMultiplier),
        stdDev
    };
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
    // Candles are returned DESC by time, reverse to get oldest first
    return candles.reverse();
}

/**
 * Generate trade signal based on Bollinger Band position
 * @param {number} currentPrice - Current price
 * @param {Object} bands - Bollinger Bands { upper, middle, lower }
 * @returns {string} Signal: 'buy', 'sell', or 'hold'
 */
function generateSignal(currentPrice, bands) {
    if (!bands) return 'hold';

    if (currentPrice < bands.lower) {
        return 'buy';  // Price below lower band - oversold
    }
    if (currentPrice > bands.upper) {
        return 'sell'; // Price above upper band - overbought
    }
    return 'hold';
}

/**
 * Main strategy function - can be called by strategy runner
 * 
 * @param {Object} config - Strategy configuration
 * @param {string} config.ticker - Ticker symbol to trade
 * @param {number} config.period - Lookback period for Bollinger Bands (default: 20)
 * @param {number} config.stdDevMultiplier - Standard deviation multiplier (default: 2)
 * @param {number} config.positionSize - Position size for trades (default: 100)
 * @param {string} config.interval - Candle interval (default: '5m')
 * @returns {Promise<Object>} Signal result with trade details
 */
async function meanReversionStrategy(config) {
    const {
        ticker,
        period = 20,
        stdDevMultiplier = 2,
        positionSize = 100,
        interval = '5m'
    } = config;

    if (!ticker) {
        throw new Error('Ticker is required');
    }

    // Fetch enough candles for calculation + some buffer
    const fetchLimit = period + 10;
    const candles = await fetchCandles(ticker, interval, fetchLimit);

    if (!candles || candles.length < period) {
        return {
            ticker,
            signal: 'hold',
            reason: 'Insufficient candle data',
            data: {
                candlesAvailable: candles?.length || 0,
                periodRequired: period
            }
        };
    }

    // Extract closing prices (oldest first)
    const closePrices = candles.map(c => parseFloat(c.close));
    const currentPrice = closePrices[closePrices.length - 1];

    // Calculate Bollinger Bands
    const bands = calculateBollingerBands(closePrices, period, stdDevMultiplier);

    if (!bands) {
        return {
            ticker,
            signal: 'hold',
            reason: 'Failed to calculate Bollinger Bands'
        };
    }

    // Generate signal
    const signal = generateSignal(currentPrice, bands);

    // Determine reason based on signal
    let reason;
    if (signal === 'buy') {
        reason = `Price ${currentPrice.toFixed(2)} below lower band ${bands.lower.toFixed(2)} - oversold condition`;
    } else if (signal === 'sell') {
        reason = `Price ${currentPrice.toFixed(2)} above upper band ${bands.upper.toFixed(2)} - overbought condition`;
    } else {
        reason = `Price ${currentPrice.toFixed(2)} within bands [${bands.lower.toFixed(2)}, ${bands.upper.toFixed(2)}]`;
    }

    return {
        ticker,
        signal,
        reason,
        positionSize: signal !== 'hold' ? positionSize : 0,
        data: {
            currentPrice,
            interval,
            bollingerBands: {
                upper: +bands.upper.toFixed(4),
                middle: +bands.middle.toFixed(4),
                lower: +bands.lower.toFixed(4),
                stdDev: +bands.stdDev.toFixed(4)
            },
            config: {
                period,
                stdDevMultiplier,
                positionSize
            }
        }
    };
}

module.exports = {
    meanReversionStrategy,
    calculateBollingerBands,
    calculateSMA,
    calculateStdDev,
    fetchCandles,
    generateSignal
};
