const { v4: uuid } = require('uuid');
const { query, getAll, getOne } = require('./db');
const engine = require('./engine');

// ─── Order Matching Engine ─────────────────────────────────────────────────────
// Runs every tick — scans all open orders and checks fill conditions

let fillCallback = null; // set by wsServer for broadcasting fills

function setFillCallback(cb) { fillCallback = cb; }

async function matchAll() {
    try {
        const openOrders = await getAll("SELECT * FROM orders WHERE status = 'open'");
        if (openOrders.length === 0) return;

        const now = Date.now();

        for (const order of openOrders) {
            const priceData = engine.getPrice(order.ticker);
            if (!priceData) continue;

            const currentPrice = priceData.price;
            const bid = priceData.bid;
            const ask = priceData.ask;

            try {
                switch (order.type) {
                    case 'market':
                        await executeMarketOrder(order, currentPrice, bid, ask, now);
                        break;
                    case 'limit':
                        await checkLimitOrder(order, currentPrice, bid, ask, now);
                        break;
                    case 'stop':
                    case 'stop-loss':
                        await checkStopOrder(order, currentPrice, now);
                        break;
                    case 'stop-limit':
                        await checkStopLimitOrder(order, currentPrice, now);
                        break;
                    case 'take-profit':
                        await checkTakeProfitOrder(order, currentPrice, now);
                        break;
                    case 'trailing-stop':
                        await checkTrailingStop(order, currentPrice, now);
                        break;
                }
            } catch (e) {
                console.error(\`[Matcher] Error processing order \${order.id}:\`, e.message);
            }
        }

        // Check margin calls
        await checkMarginCalls(now);
    } catch (e) {
        console.error('[Matcher] Error in matchAll:', e.message);
    }
}

async function executeMarketOrder(order, currentPrice, bid, ask, now) {
    const remainQty = order.qty - order.filled_qty;
    if (remainQty <= 0) return;

    // Slippage: larger orders get worse fills
    const slippageBps = Math.min(remainQty * 0.5, 50); // max 50bps slippage
    const slippage = currentPrice * (slippageBps / 10000);

    let fillPrice;
    if (order.side === 'buy') {
        fillPrice = ask + slippage;
    } else {
        fillPrice = bid - slippage;
    }
    fillPrice = Math.max(fillPrice, 0.01);

    await executeFill(order, remainQty, fillPrice, now);
}

async function checkLimitOrder(order, currentPrice, bid, ask, now) {
    if (order.side === 'buy' && ask <= order.limit_price) {
        const fillPrice = Math.min(ask, order.limit_price);
        const remainQty = order.qty - order.filled_qty;
        await executeFill(order, remainQty, fillPrice, now);
    } else if (order.side === 'sell' && bid >= order.limit_price) {
        const fillPrice = Math.max(bid, order.limit_price);
        const remainQty = order.qty - order.filled_qty;
        await executeFill(order, remainQty, fillPrice, now);
    }
}

async function checkStopOrder(order, currentPrice, now) {
    // Stop-loss: triggers when price falls below stop (for sells) or rises above (for buys)
    let triggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) triggered = true;

    if (triggered) {
        const priceData = engine.getPrice(order.ticker);
        const fillPrice = order.side === 'buy' ? priceData.ask : priceData.bid;
        const remainQty = order.qty - order.filled_qty;
        await executeFill(order, remainQty, fillPrice, now);
    }
}

async function checkStopLimitOrder(order, currentPrice, now) {
    let stopTriggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) stopTriggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) stopTriggered = true;

    if (stopTriggered) {
        // Convert to limit order behavior
        const priceData = engine.getPrice(order.ticker);
        if (order.side === 'buy' && priceData.ask <= order.limit_price) {
            await executeFill(order, order.qty - order.filled_qty, Math.min(priceData.ask, order.limit_price), now);
        } else if (order.side === 'sell' && priceData.bid >= order.limit_price) {
            await executeFill(order, order.qty - order.filled_qty, Math.max(priceData.bid, order.limit_price), now);
        }
    }
}

async function checkTakeProfitOrder(order, currentPrice, now) {
    let triggered = false;
    if (order.side === 'sell' && currentPrice >= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice <= order.stop_price) triggered = true;

    if (triggered) {
        const priceData = engine.getPrice(order.ticker);
        const fillPrice = order.side === 'buy' ? priceData.ask : priceData.bid;
        await executeFill(order, order.qty - order.filled_qty, fillPrice, now);
    }
}

async function checkTrailingStop(order, currentPrice, now) {
    if (!order.trail_pct) return;

    // Update trail high
    let trailHigh = order.trail_high || currentPrice;
    if (order.side === 'sell') {
        if (currentPrice > trailHigh) {
            trailHigh = currentPrice;
            await query('UPDATE orders SET trail_high = $1 WHERE id = $2', [trailHigh, order.id]);
        }
        const stopPrice = trailHigh * (1 - order.trail_pct / 100);
        if (currentPrice <= stopPrice) {
            const priceData = engine.getPrice(order.ticker);
            await executeFill(order, order.qty - order.filled_qty, priceData.bid, now);
        }
    } else {
        // Buy trailing stop (rare but supported)
        if (currentPrice < trailHigh) {
            trailHigh = currentPrice;
            await query('UPDATE orders SET trail_high = $1 WHERE id = $2', [trailHigh, order.id]);
        }
        const stopPrice = trailHigh * (1 + order.trail_pct / 100);
        if (currentPrice >= stopPrice) {
            const priceData = engine.getPrice(order.ticker);
            await executeFill(order, order.qty - order.filled_qty, priceData.ask, now);
        }
    }
}

async function executeFill(order, qty, price, now) {
    const total = qty * price;
    const decimals = engine.getDecimals(order.ticker);
    price = +price.toFixed(decimals);

    // Get user
    const user = await getOne('SELECT * FROM users WHERE id = $1', [order.user_id]);
    if (!user) return;

    // Check affordability for buys (double check, though done at order placement)
    if (order.side === 'buy' && total > user.cash) {
        // Partial fill with available cash
        qty = Math.floor(user.cash / price);
        if (qty <= 0) {
            await query("UPDATE orders SET status = 'cancelled', cancelled_at = $1 WHERE id = $2", [now, order.id]);
            return;
        }
    }

    const fillTotal = qty * price;

    // Update cash
    let newCash;
    if (order.side === 'buy') {
        newCash = user.cash - fillTotal;
    } else {
        newCash = user.cash + fillTotal;
    }
    await query('UPDATE users SET cash = $1 WHERE id = $2', [+newCash.toFixed(2), order.user_id]);

    // Update position
    const position = await getOne('SELECT * FROM positions WHERE user_id = $1 AND ticker = $2', [order.user_id, order.ticker]);
    let pnl = 0;

    if (order.side === 'buy') {
        if (position) {
            const newQty = position.qty + qty;
            const newAvgCost = newQty !== 0 ? ((position.qty * position.avg_cost + qty * price) / newQty) : 0;
            await query(
                'UPDATE positions SET qty = $1, avg_cost = $2 WHERE id = $3', // simplified update
                [newQty, +newAvgCost.toFixed(decimals), position.id]
            );
        } else {
            await query(
                'INSERT INTO positions (id, user_id, ticker, qty, avg_cost, opened_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [uuid(), order.user_id, order.ticker, qty, price, now]
            );
        }
    } else {
        // Sell
        if (position && position.qty > 0) {
            pnl = (price - position.avg_cost) * Math.min(qty, position.qty);
            const newQty = position.qty - qty;
            if (Math.abs(newQty) < 0.0001) {
                await query('DELETE FROM positions WHERE id = $1', [position.id]);
            } else {
                await query(
                    'UPDATE positions SET qty = $1 WHERE id = $2',
                    [newQty, position.id]
                );
            }
        } else {
            // Short sell
            const shortQty = -(position ? position.qty : 0) - qty;
            // avg cost for short is entry price
            if (position) {
                const newQty = position.qty - qty;
                // Average cost logic for adding to short? 
                // Simplified: new avg cost = weighted avg
                const currentShortQty = Math.abs(position.qty);
                const newTotalShort = currentShortQty + qty;
                const newAvg = ((currentShortQty * position.avg_cost) + (qty * price)) / newTotalShort;
                
                await query('UPDATE positions SET qty = $1, avg_cost = $2 WHERE id = $3', [newQty, newAvg, position.id]);
            } else {
                await query(
                    'INSERT INTO positions (id, user_id, ticker, qty, avg_cost, opened_at) VALUES ($1, $2, $3, $4, $5, $6)',
                    [uuid(), order.user_id, order.ticker, -qty, price, now]
                );
            }
        }
    }

    // Record trade
    const tradeId = uuid();
    await query(
        'INSERT INTO trades (id, order_id, user_id, ticker, side, qty, price, total, pnl, executed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [tradeId, order.id, order.user_id, order.ticker, order.side, qty, price, fillTotal, +pnl.toFixed(2), now]
    );

    // Update order status
    const newFilledQty = order.filled_qty + qty;
    const status = newFilledQty >= order.qty ? 'filled' : 'partial';
    await query(
        'UPDATE orders SET status = $1, filled_qty = $2, filled_at = $3 WHERE id = $4',
        [status, newFilledQty, now, order.id]
    );

    // Cancel OCO counterpart if applicable
    if (order.oco_id) {
        await query("UPDATE orders SET status = 'cancelled', cancelled_at = $1 WHERE oco_id = $2 AND id != $3 AND status = 'open'", [now, order.oco_id, order.id]);
    }

    // Apply order flow impact
    engine.addOrderFlowImpact(order.ticker, order.side, fillTotal);

    // Broadcast fill
    if (fillCallback) {
        fillCallback(order.user_id, {
            type: 'fill',
            orderId: order.id,
            tradeId,
            ticker: order.ticker,
            side: order.side,
            qty,
            price,
            total: fillTotal,
            pnl: +pnl.toFixed(2),
            timestamp: now
        });
    }
}

async function checkMarginCalls(now) {
    // Get all users with short positions
    // Optimized: Query positions directly
    // SELECT * FROM positions WHERE qty < 0
    const shortPositions = await getAll('SELECT * FROM positions WHERE qty < 0');
    if (shortPositions.length === 0) return;

    // Group by user
    const userMap = {};
    for (const p of shortPositions) {
        if (!userMap[p.user_id]) userMap[p.user_id] = [];
        userMap[p.user_id].push(p);
    }

    for (const userId in userMap) {
        const positions = userMap[userId];
        const user = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
        if (!user) continue;

        let totalShortExposure = 0;
        const riskyPositions = [];

        // Determine exposure
        for (const pos of positions) {
            const priceData = engine.getPrice(pos.ticker);
            if (priceData) {
                const exposure = Math.abs(pos.qty) * priceData.price;
                totalShortExposure += exposure;
                riskyPositions.push({ ...pos, currentPrice: priceData.price, exposure });
            }
        }

        // Calculate total portfolio equity (Cash + Longs + Shorts)
        // Need all positions for this user
        const allPositions = await getAll('SELECT * FROM positions WHERE user_id = $1', [userId]);
        let portfolioValue = user.cash;
        
        for (const pos of allPositions) {
            const priceData = engine.getPrice(pos.ticker);
            if (priceData) {
                portfolioValue += pos.qty * priceData.price;
            }
        }

        // Margin call if equity < 110% of short exposure (approx)
        if (portfolioValue < totalShortExposure * 1.1) {
            // Auto-cover shorts
            for (const sp of riskyPositions) {
                const coverQty = Math.abs(sp.qty);
                const coverPrice = engine.getPrice(sp.ticker).ask;
                const coverTotal = coverQty * coverPrice;

                const pnl = (sp.avg_cost - coverPrice) * coverQty;
                const newCash = user.cash - coverTotal;
                
                await query('UPDATE users SET cash = $1 WHERE id = $2', [+newCash.toFixed(2), user.id]);
                await query('DELETE FROM positions WHERE id = $1', [sp.id]);

                const tradeId = uuid();
                // We don't have an order ID for margin call, maybe make a dummy one or allow null? schema says NOT NULL.
                // Let's create a dummy system order for margin calls? or just insert with a special ID.
                // For now, let's skip FK constraint issue or create a dummy order wrapper.
                // Insert dummy order first
                const orderId = uuid();
                await query(
                    "INSERT INTO orders (id, user_id, ticker, type, side, qty, filled_qty, status, created_at, filled_at) VALUES ($1, $2, $3, 'market', 'buy', $4, $4, 'filled', $5, $5)",
                    [orderId, user.id, sp.ticker, coverQty, now]
                );

                await query(
                    'INSERT INTO trades (id, order_id, user_id, ticker, side, qty, price, total, pnl, executed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                    [tradeId, orderId, user.id, sp.ticker, 'buy', coverQty, coverPrice, coverTotal, +pnl.toFixed(2), now]
                );

                if (fillCallback) {
                    fillCallback(user.id, {
                        type: 'margin_call',
                        ticker: sp.ticker,
                        qty: coverQty,
                        price: coverPrice,
                        pnl: +pnl.toFixed(2),
                        timestamp: now
                    });
                }
            }
        }
    }
}

module.exports = { matchAll, setFillCallback };
