const { stmts } = require('../db');

/**
 * Grid Trading Strategy
 * 
 * Places buy/sell orders at fixed price intervals around current price.
 * BUY at lower grid levels, SELL at upper grid levels.
 * Tracks grid positions in memory.
 */

// In-memory grid position tracking: Map<fundId_ticker, GridState>
const gridStates = new Map();

/**
 * Get or initialize grid state for a fund/ticker combination
 */
function getGridState(fundId, ticker) {
    const key = `${fundId}_${ticker}`;
    if (!gridStates.has(key)) {
        gridStates.set(key, {
            activeBuyLevels: new Set(),
            activeSellLevels: new Set(),
            lastCenterPrice: null,
            filledLevels: []
        });
    }
    return gridStates.get(key);
}

/**
 * Calculate all grid levels around center price
 * @param {number} centerPrice - Current/center price
 * @param {number} gridSpacing - Price gap between levels
 * @param {number} gridLevels - Number of levels above and below center
 * @returns {Object} Grid levels { buyLevels, sellLevels }
 */
function calculateGridLevels(centerPrice, gridSpacing, gridLevels) {
    const buyLevels = [];
    const sellLevels = [];
    
    for (let i = 1; i <= gridLevels; i++) {
        buyLevels.push({
            level: -i,
            price: centerPrice - (gridSpacing * i),
            side: 'BUY'
        });
        sellLevels.push({
            level: i,
            price: centerPrice + (gridSpacing * i),
            side: 'SELL'
        });
    }
    
    // Sort buy levels descending (lowest first to execute)
    buyLevels.sort((a, b) => a.price - b.price);
    // Sort sell levels ascending (highest first to execute)
    sellLevels.sort((a, b) => a.price - b.price);
    
    return { buyLevels, sellLevels };
}

/**
 * Find which grid level should trigger based on current price
 * @param {number} currentPrice - Current market price
 * @param {Object[]} buyLevels - Array of buy level objects
 * @param {Object[]} sellLevels - Array of sell level objects
 * @param {Set} activeBuyLevels - Set of active buy level indices
 * @param {Set} activeSellLevels - Set of active sell level indices
 * @returns {Object|null} Triggered level or null
 */
function findTriggeredLevel(currentPrice, buyLevels, sellLevels, activeBuyLevels, activeSellLevels) {
    // Check buy levels (price dropped to or below level)
    for (const level of buyLevels) {
        const levelKey = level.level;
        if (!activeBuyLevels.has(levelKey) && currentPrice <= level.price) {
            return { ...level, type: 'buy' };
        }
    }
    
    // Check sell levels (price rose to or above level)
    for (const level of sellLevels) {
        const levelKey = level.level;
        if (!activeSellLevels.has(levelKey) && currentPrice >= level.price) {
            return { ...level, type: 'sell' };
        }
    }
    
    return null;
}

/**
 * Fetch recent candle data from database
 */
async function fetchCandles(ticker, interval, limit) {
    const candles = await stmts.getCandles.all(ticker, interval, limit);
    return candles.reverse();
}

/**
 * Main strategy execution function
 * 
 * @param {string} fundId - Fund ID executing the strategy
 * @param {Object} config - Strategy configuration
 * @param {string} config.ticker - Ticker symbol to trade
 * @param {number} config.gridSpacing - Price gap between grid levels (default: 1)
 * @param {number} config.gridLevels - Number of levels above/below center (default: 5)
 * @param {number} config.positionSize - Position size per grid level (default: 100)
 * @param {string} config.interval - Candle interval (default: '5m')
 * @param {number} config.recenterThreshold - Price movement % to recenter grid (default: 10)
 * @returns {Promise<Object>} Signal result { action, ticker, quantity, reason }
 */
async function execute(fundId, config) {
    const {
        ticker,
        gridSpacing = 1,
        gridLevels = 5,
        positionSize = 100,
        interval = '5m',
        recenterThreshold = 10
    } = config;

    if (!ticker) {
        throw new Error('Ticker is required');
    }

    if (!fundId) {
        throw new Error('Fund ID is required');
    }

    // Fetch current price from candles
    const candles = await fetchCandles(ticker, interval, 2);
    
    if (!candles || candles.length < 1) {
        return {
            action: 'HOLD',
            ticker,
            quantity: 0,
            reason: 'Insufficient candle data for grid trading'
        };
    }

    const currentPrice = parseFloat(candles[candles.length - 1].close);
    
    // Get or initialize grid state
    const gridState = getGridState(fundId, ticker);
    
    // Initialize or recenter grid if needed
    let shouldRecenter = false;
    if (gridState.lastCenterPrice === null) {
        shouldRecenter = true;
    } else {
        const priceMovement = Math.abs((currentPrice - gridState.lastCenterPrice) / gridState.lastCenterPrice) * 100;
        if (priceMovement >= recenterThreshold) {
            shouldRecenter = true;
        }
    }
    
    if (shouldRecenter) {
        gridState.lastCenterPrice = currentPrice;
        gridState.activeBuyLevels = new Set();
        gridState.activeSellLevels = new Set();
        gridState.filledLevels = [];
    }
    
    // Calculate grid levels
    const { buyLevels, sellLevels } = calculateGridLevels(
        gridState.lastCenterPrice,
        gridSpacing,
        gridLevels
    );
    
    // Find triggered level
    const triggered = findTriggeredLevel(
        currentPrice,
        buyLevels,
        sellLevels,
        gridState.activeBuyLevels,
        gridState.activeSellLevels
    );
    
    if (!triggered) {
        return {
            action: 'HOLD',
            ticker,
            quantity: 0,
            reason: `Price ${currentPrice.toFixed(2)} within grid range [${(gridState.lastCenterPrice - gridSpacing * gridLevels).toFixed(2)}, ${(gridState.lastCenterPrice + gridSpacing * gridLevels).toFixed(2)}]`
        };
    }
    
    // Mark level as active (filled)
    if (triggered.type === 'buy') {
        gridState.activeBuyLevels.add(triggered.level);
        gridState.filledLevels.push({ ...triggered, timestamp: Date.now() });
    } else {
        gridState.activeSellLevels.add(triggered.level);
        gridState.filledLevels.push({ ...triggered, timestamp: Date.now() });
    }
    
    // Check if we should take profit (opposite level exists)
    const oppositeLevel = triggered.type === 'buy' 
        ? sellLevels.find(l => l.level === Math.abs(triggered.level))
        : buyLevels.find(l => l.level === -Math.abs(triggered.level));
    
    const action = triggered.type === 'buy' ? 'BUY' : 'SELL';
    
    let reason;
    if (triggered.type === 'buy') {
        reason = `Grid BUY triggered at level ${triggered.level} (price: ${triggered.price.toFixed(2)}, current: ${currentPrice.toFixed(2)})`;
    } else {
        reason = `Grid SELL triggered at level ${triggered.level} (price: ${triggered.price.toFixed(2)}, current: ${currentPrice.toFixed(2)})`;
    }
    
    return {
        action,
        ticker,
        quantity: positionSize,
        reason,
        data: {
            currentPrice,
            centerPrice: gridState.lastCenterPrice,
            triggeredLevel: triggered.level,
            triggeredPrice: triggered.price,
            activeBuyLevels: Array.from(gridState.activeBuyLevels),
            activeSellLevels: Array.from(gridState.activeSellLevels),
            gridConfig: {
                gridSpacing,
                gridLevels,
                positionSize
            }
        }
    };
}

/**
 * Reset grid state for a fund/ticker (useful for testing or manual reset)
 */
function resetGridState(fundId, ticker) {
    const key = `${fundId}_${ticker}`;
    gridStates.delete(key);
}

/**
 * Get current grid state (for debugging/monitoring)
 */
function getGridStateInfo(fundId, ticker) {
    const key = `${fundId}_${ticker}`;
    const state = gridStates.get(key);
    if (!state) return null;
    
    return {
        lastCenterPrice: state.lastCenterPrice,
        activeBuyLevels: Array.from(state.activeBuyLevels),
        activeSellLevels: Array.from(state.activeSellLevels),
        filledLevelsCount: state.filledLevels.length
    };
}

module.exports = {
    execute,
    calculateGridLevels,
    findTriggeredLevel,
    getGridState,
    resetGridState,
    getGridStateInfo
};
