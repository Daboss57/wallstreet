const engine = require('./engine');

// ─── Simulated Order Book ──────────────────────────────────────────────────────
// Generates realistic bid/ask depth around the current price
// Also incorporates real user limit orders sitting on the book

function generateBook(ticker, userOrders = []) {
    const priceData = engine.getPrice(ticker);
    if (!priceData) return { bids: [], asks: [] };

    const price = priceData.price;
    const def = engine.getTickerDef(ticker);
    const vol = priceData.volatility || def.volatility;
    const decimals = engine.getDecimals(ticker);

    // Step size between levels
    const step = Math.max(price * vol * 0.015, Math.pow(10, -decimals));

    const bids = [];
    const asks = [];

    // Generate 10 levels each side with realistic depth
    for (let i = 0; i < 10; i++) {
        const bidPrice = +(price - step * (i + 1)).toFixed(decimals);
        const askPrice = +(price + step * (i + 1)).toFixed(decimals);

        // Depth decreases as we move away from mid, with randomness
        const baseBidQty = Math.floor((800 - i * 50) * (0.5 + Math.random()));
        const baseAskQty = Math.floor((800 - i * 50) * (0.5 + Math.random()));

        bids.push({ price: bidPrice, qty: baseBidQty });
        asks.push({ price: askPrice, qty: baseAskQty });
    }

    // Inject user limit orders into the book
    for (const order of userOrders) {
        if (order.status !== 'open') continue;
        if (order.type !== 'limit') continue;

        const levels = order.side === 'buy' ? bids : asks;
        const existing = levels.find(l => Math.abs(l.price - order.limit_price) < step * 0.5);
        if (existing) {
            existing.qty += (order.qty - order.filled_qty);
        } else {
            levels.push({ price: order.limit_price, qty: order.qty - order.filled_qty, user: true });
            // Re-sort
            if (order.side === 'buy') {
                levels.sort((a, b) => b.price - a.price);
                while (levels.length > 10) levels.pop();
            } else {
                levels.sort((a, b) => a.price - b.price);
                while (levels.length > 10) levels.pop();
            }
        }
    }

    // Sort final
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    return {
        ticker,
        bids: bids.slice(0, 10),
        asks: asks.slice(0, 10),
        spread: asks.length && bids.length ? +(asks[0].price - bids[0].price).toFixed(decimals) : 0,
        mid: price,
        timestamp: Date.now()
    };
}

module.exports = { generateBook };
