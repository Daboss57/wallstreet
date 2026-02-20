const { stmts } = require('../db');

/**
 * Pairs Trading Strategy
 * 
 * Monitors two correlated tickers and trades based on spread deviation.
 * BUY tickerA + SELL tickerB when spread < mean - threshold
 * SELL tickerA + BUY tickerB when spread > mean + threshold
 */

// In-memory state for tracking positions: Map<fundId_pairKey, PairState>
const pairStates = new Map();

/**
 * Get or initialize pair state
 */
function getPairState(fundId, tickerA, tickerB) {
    const key = `${fundId}_${tickerA}_${tickerB}`;
    if (!pairStates.has(key)) {
        pairStates.set(key, {
            spreadHistory: [],
            position: 'neutral', // 'neutral', 'longA_shortB', 'shortA_longB'
            entrySpread: null,
            lastSignal: null
        });
    }
    return pairStates.get(key);
}

/**
 * Calculate Simple Moving Average
 */
function calculateSMA(values) {
    if (!values || values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Calculate Standard Deviation
 */
function calculateStdDev(values, mean) {
    if (!values || values.length === 0) return 0;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.sqrt(avgSquaredDiff);
}

/**
 * Calculate spread ratio (priceA / priceB)
 */
function calculateSpread(priceA, priceB) {
    if (!priceB || priceB === 0) return null;
    return priceA / priceB;
}

/**
 * Fetch recent candle data from database
 */
async function fetchCandles(ticker, interval, limit) {
    const candles = await stmts.getCandles.all(ticker, interval, limit);
    return candles.reverse();
}

/**
 * Fetch and align price data for both tickers
 * @returns {Promise<Object[]>} Array of aligned price pairs { priceA, priceB, time }
 */
async function fetchAlignedPrices(tickerA, tickerB, interval, limit) {
    const [candlesA, candlesB] = await Promise.all([
        fetchCandles(tickerA, interval, limit),
        fetchCandles(tickerB, interval, limit)
    ]);
    
    if (!candlesA.length || !candlesB.length) {
        return [];
    }
    
    // Create map of time -> price for tickerB
    const priceBMap = new Map();
    for (const candle of candlesB) {
        priceBMap.set(candle.open_time, parseFloat(candle.close));
    }
    
    // Align prices by matching open_time
    const aligned = [];
    for (const candle of candlesA) {
        const priceB = priceBMap.get(candle.open_time);
        if (priceB !== undefined) {
            aligned.push({
                time: candle.open_time,
                priceA: parseFloat(candle.close),
                priceB: priceB
            });
        }
    }
    
    return aligned;
}

/**
 * Generate trading signal based on spread deviation
 * @param {number} currentSpread - Current spread ratio
 * @param {number} meanSpread - Mean spread over lookback
 * @param {number} stdDev - Standard deviation of spread
 * @param {number} threshold - StdDev multiplier for entry
 * @param {string} currentPosition - Current position state
 * @returns {Object} Signal { actionA, actionB, reason }
 */
function generatePairsSignal(currentSpread, meanSpread, stdDev, threshold, currentPosition) {
    const upperBound = meanSpread + (stdDev * threshold);
    const lowerBound = meanSpread - (stdDev * threshold);
    
    // Spread too low: buy A (cheap), sell B (expensive)
    if (currentSpread < lowerBound && currentPosition !== 'longA_shortB') {
        return {
            actionA: 'BUY',
            actionB: 'SELL',
            reason: `Spread ${currentSpread.toFixed(4)} below lower bound ${lowerBound.toFixed(4)} (mean: ${meanSpread.toFixed(4)}, threshold: ${threshold}σ)`
        };
    }
    
    // Spread too high: sell A (expensive), buy B (cheap)
    if (currentSpread > upperBound && currentPosition !== 'shortA_longB') {
        return {
            actionA: 'SELL',
            actionB: 'BUY',
            reason: `Spread ${currentSpread.toFixed(4)} above upper bound ${upperBound.toFixed(4)} (mean: ${meanSpread.toFixed(4)}, threshold: ${threshold}σ)`
        };
    }
    
    // Check for mean reversion exit
    if (currentPosition === 'longA_shortB' && currentSpread >= meanSpread) {
        return {
            actionA: 'SELL',
            actionB: 'BUY',
            reason: `Closing long A/short B: spread reverted to mean (${currentSpread.toFixed(4)} vs mean ${meanSpread.toFixed(4)})`
        };
    }
    
    if (currentPosition === 'shortA_longB' && currentSpread <= meanSpread) {
        return {
            actionA: 'BUY',
            actionB: 'SELL',
            reason: `Closing short A/long B: spread reverted to mean (${currentSpread.toFixed(4)} vs mean ${meanSpread.toFixed(4)})`
        };
    }
    
    return {
        actionA: 'HOLD',
        actionB: 'HOLD',
        reason: `Spread ${currentSpread.toFixed(4)} within bounds [${lowerBound.toFixed(4)}, ${upperBound.toFixed(4)}]`
    };
}

/**
 * Main strategy execution function
 * 
 * @param {string} fundId - Fund ID executing the strategy
 * @param {Object} config - Strategy configuration
 * @param {string} config.tickerA - First ticker in pair
 * @param {string} config.tickerB - Second ticker in pair
 * @param {number} config.lookback - Lookback period for spread mean (default: 20)
 * @param {number} config.stdDevThreshold - StdDev multiplier for entry threshold (default: 2)
 * @param {number} config.positionSize - Position size for each leg (default: 100)
 * @param {string} config.interval - Candle interval (default: '5m')
 * @returns {Promise<Object>} Signal result { action, ticker, quantity, reason }
 */
async function execute(fundId, config) {
    const {
        tickerA,
        tickerB,
        lookback = 20,
        stdDevThreshold = 2,
        positionSize = 100,
        interval = '5m'
    } = config;

    if (!tickerA || !tickerB) {
        throw new Error('Both tickerA and tickerB are required');
    }

    if (!fundId) {
        throw new Error('Fund ID is required');
    }

    // Fetch aligned price data
    const alignedPrices = await fetchAlignedPrices(tickerA, tickerB, interval, lookback + 5);
    
    if (alignedPrices.length < lookback) {
        return {
            action: 'HOLD',
            ticker: `${tickerA}/${tickerB}`,
            quantity: 0,
            reason: `Insufficient aligned price data (${alignedPrices.length} points, need ${lookback})`
        };
    }

    // Calculate spreads
    const spreads = alignedPrices.slice(-lookback).map(p => calculateSpread(p.priceA, p.priceB));
    const currentSpread = spreads[spreads.length - 1];
    const currentPriceA = alignedPrices[alignedPrices.length - 1].priceA;
    const currentPriceB = alignedPrices[alignedPrices.length - 1].priceB;
    
    // Calculate mean and stdDev
    const meanSpread = calculateSMA(spreads);
    const stdDev = calculateStdDev(spreads, meanSpread);
    
    // Get pair state
    const pairState = getPairState(fundId, tickerA, tickerB);
    
    // Generate signal
    const signal = generatePairsSignal(
        currentSpread,
        meanSpread,
        stdDev,
        stdDevThreshold,
        pairState.position
    );
    
    // Update state based on signal
    if (signal.actionA === 'BUY' && signal.actionB === 'SELL') {
        if (pairState.position === 'shortA_longB') {
            // Closing position
            pairState.position = 'neutral';
            pairState.entrySpread = null;
        } else {
            // Opening position
            pairState.position = 'longA_shortB';
            pairState.entrySpread = currentSpread;
        }
    } else if (signal.actionA === 'SELL' && signal.actionB === 'BUY') {
        if (pairState.position === 'longA_shortB') {
            // Closing position
            pairState.position = 'neutral';
            pairState.entrySpread = null;
        } else {
            // Opening position
            pairState.position = 'shortA_longB';
            pairState.entrySpread = currentSpread;
        }
    }
    
    // For the primary signal, we return action for tickerA
    // The caller can check data.legs for both actions
    const primaryAction = signal.actionA;
    const primaryTicker = tickerA;
    
    // Determine quantity based on whether we're opening or closing
    let quantity = positionSize;
    
    return {
        action: primaryAction,
        ticker: primaryTicker,
        quantity,
        reason: signal.reason,
        data: {
            spread: {
                current: currentSpread,
                mean: meanSpread,
                stdDev,
                upperBound: meanSpread + (stdDev * stdDevThreshold),
                lowerBound: meanSpread - (stdDev * stdDevThreshold)
            },
            prices: {
                tickerA: currentPriceA,
                tickerB: currentPriceB
            },
            legs: {
                tickerA: { action: signal.actionA, quantity: positionSize },
                tickerB: { action: signal.actionB, quantity: positionSize }
            },
            position: pairState.position,
            config: {
                tickerA,
                tickerB,
                lookback,
                stdDevThreshold,
                positionSize
            }
        }
    };
}

/**
 * Reset pair state
 */
function resetPairState(fundId, tickerA, tickerB) {
    const key = `${fundId}_${tickerA}_${tickerB}`;
    pairStates.delete(key);
}

/**
 * Get current pair state info
 */
function getPairStateInfo(fundId, tickerA, tickerB) {
    const key = `${fundId}_${tickerA}_${tickerB}`;
    const state = pairStates.get(key);
    if (!state) return null;
    
    return {
        position: state.position,
        entrySpread: state.entrySpread,
        lastSignal: state.lastSignal
    };
}

module.exports = {
    execute,
    calculateSpread,
    calculateSMA,
    calculateStdDev,
    generatePairsSignal,
    getPairState,
    resetPairState,
    getPairStateInfo,
    fetchAlignedPrices
};
