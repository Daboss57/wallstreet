const { v4: uuid } = require('uuid');
const { stmts } = require('./db');
const engine = require('./engine');

// ─── Order Matching Engine ─────────────────────────────────────────────────────
// Runs every tick — scans all open orders and checks fill conditions

let fillCallback = null; // set by wsServer for broadcasting fills

function setFillCallback(cb) { fillCallback = cb; }

function matchAll() {
    const openOrders = stmts.getAllOpenOrders.all();
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
                    executeMarketOrder(order, currentPrice, bid, ask, now);
                    break;
                case 'limit':
                    checkLimitOrder(order, currentPrice, bid, ask, now);
                    break;
                case 'stop':
                case 'stop-loss':
                    checkStopOrder(order, currentPrice, now);
                    break;
                case 'stop-limit':
                    checkStopLimitOrder(order, currentPrice, now);
                    break;
                case 'take-profit':
                    checkTakeProfitOrder(order, currentPrice, now);
                    break;
                case 'trailing-stop':
                    checkTrailingStop(order, currentPrice, now);
                    break;
            }
        } catch (e) {
            console.error(`[Matcher] Error processing order ${order.id}:`, e.message);
        }
    }

    // Check margin calls
    checkMarginCalls(now);
}

function executeMarketOrder(order, currentPrice, bid, ask, now) {
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

    executeFill(order, remainQty, fillPrice, now);
}

function checkLimitOrder(order, currentPrice, bid, ask, now) {
    if (order.side === 'buy' && ask <= order.limit_price) {
        const fillPrice = Math.min(ask, order.limit_price);
        const remainQty = order.qty - order.filled_qty;
        executeFill(order, remainQty, fillPrice, now);
    } else if (order.side === 'sell' && bid >= order.limit_price) {
        const fillPrice = Math.max(bid, order.limit_price);
        const remainQty = order.qty - order.filled_qty;
        executeFill(order, remainQty, fillPrice, now);
    }
}

function checkStopOrder(order, currentPrice, now) {
    // Stop-loss: triggers when price falls below stop (for sells) or rises above (for buys)
    let triggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) triggered = true;

    if (triggered) {
        const priceData = engine.getPrice(order.ticker);
        const fillPrice = order.side === 'buy' ? priceData.ask : priceData.bid;
        const remainQty = order.qty - order.filled_qty;
        executeFill(order, remainQty, fillPrice, now);
    }
}

function checkStopLimitOrder(order, currentPrice, now) {
    let stopTriggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) stopTriggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) stopTriggered = true;

    if (stopTriggered) {
        // Convert to limit order behavior
        const priceData = engine.getPrice(order.ticker);
        if (order.side === 'buy' && priceData.ask <= order.limit_price) {
            executeFill(order, order.qty - order.filled_qty, Math.min(priceData.ask, order.limit_price), now);
        } else if (order.side === 'sell' && priceData.bid >= order.limit_price) {
            executeFill(order, order.qty - order.filled_qty, Math.max(priceData.bid, order.limit_price), now);
        }
    }
}

function checkTakeProfitOrder(order, currentPrice, now) {
    let triggered = false;
    if (order.side === 'sell' && currentPrice >= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice <= order.stop_price) triggered = true;

    if (triggered) {
        const priceData = engine.getPrice(order.ticker);
        const fillPrice = order.side === 'buy' ? priceData.ask : priceData.bid;
        executeFill(order, order.qty - order.filled_qty, fillPrice, now);
    }
}

function checkTrailingStop(order, currentPrice, now) {
    if (!order.trail_pct) return;

    // Update trail high
    let trailHigh = order.trail_high || currentPrice;
    if (order.side === 'sell') {
        if (currentPrice > trailHigh) {
            trailHigh = currentPrice;
            stmts.updateOrderTrailHigh.run(trailHigh, order.id);
        }
        const stopPrice = trailHigh * (1 - order.trail_pct / 100);
        if (currentPrice <= stopPrice) {
            const priceData = engine.getPrice(order.ticker);
            executeFill(order, order.qty - order.filled_qty, priceData.bid, now);
        }
    } else {
        if (currentPrice < trailHigh) {
            trailHigh = currentPrice;
            stmts.updateOrderTrailHigh.run(trailHigh, order.id);
        }
        const stopPrice = trailHigh * (1 + order.trail_pct / 100);
        if (currentPrice >= stopPrice) {
            const priceData = engine.getPrice(order.ticker);
            executeFill(order, order.qty - order.filled_qty, priceData.ask, now);
        }
    }
}

function executeFill(order, qty, price, now) {
    const total = qty * price;
    const decimals = engine.getDecimals(order.ticker);
    price = +price.toFixed(decimals);

    // Get user
    const user = stmts.getUserById.get(order.user_id);
    if (!user) return;

    // Check affordability for buys
    if (order.side === 'buy' && total > user.cash) {
        // Partial fill with available cash
        qty = Math.floor(user.cash / price);
        if (qty <= 0) {
            stmts.cancelOrder.run(now, order.id);
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
    stmts.updateUserCash.run(+newCash.toFixed(2), order.user_id);

    // Update position
    const position = stmts.getPosition.get(order.user_id, order.ticker);
    let pnl = 0;

    if (order.side === 'buy') {
        if (position) {
            const newQty = position.qty + qty;
            const newAvgCost = newQty !== 0 ? ((position.qty * position.avg_cost + qty * price) / newQty) : 0;
            stmts.upsertPosition.run(position.id, order.user_id, order.ticker, newQty, +newAvgCost.toFixed(decimals), position.opened_at, newQty, +newAvgCost.toFixed(decimals), position.opened_at);
        } else {
            stmts.upsertPosition.run(uuid(), order.user_id, order.ticker, qty, price, now, qty, price, now);
        }
    } else {
        // Sell
        if (position && position.qty > 0) {
            pnl = (price - position.avg_cost) * Math.min(qty, position.qty);
            const newQty = position.qty - qty;
            if (Math.abs(newQty) < 0.0001) {
                stmts.deletePosition.run(order.user_id, order.ticker);
            } else {
                stmts.upsertPosition.run(position.id, order.user_id, order.ticker, newQty, position.avg_cost, position.opened_at, newQty, position.avg_cost, position.opened_at);
            }
        } else {
            // Short sell
            const shortQty = -(position ? position.qty : 0) - qty;
            const avgCost = price;
            if (position) {
                stmts.upsertPosition.run(position.id, order.user_id, order.ticker, position.qty - qty, position.avg_cost, position.opened_at, position.qty - qty, position.avg_cost, position.opened_at);
            } else {
                stmts.upsertPosition.run(uuid(), order.user_id, order.ticker, -qty, price, now, -qty, price, now);
            }
        }
    }

    // Record trade
    const tradeId = uuid();
    stmts.insertTrade.run(tradeId, order.id, order.user_id, order.ticker, order.side, qty, price, fillTotal, +pnl.toFixed(2), now);

    // Update order status
    const newFilledQty = order.filled_qty + qty;
    const status = newFilledQty >= order.qty ? 'filled' : 'partial';
    stmts.updateOrderStatus.run(status, newFilledQty, price, now, order.id);

    // Cancel OCO counterpart if applicable
    if (order.oco_id) {
        stmts.cancelOcoOrders.run(now, order.oco_id, order.id);
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

function checkMarginCalls(now) {
    // Get all users with short positions
    const users = stmts.getAllUsers.all();
    for (const user of users) {
        const positions = stmts.getUserPositions.get ? stmts.getUserPositions.all(user.id) : [];
        let totalShortExposure = 0;
        const shortPositions = [];

        for (const pos of positions) {
            if (pos.qty < 0) {
                const priceData = engine.getPrice(pos.ticker);
                if (priceData) {
                    const exposure = Math.abs(pos.qty) * priceData.price;
                    totalShortExposure += exposure;
                    shortPositions.push({ ...pos, currentPrice: priceData.price, exposure });
                }
            }
        }

        if (totalShortExposure === 0) continue;

        // Calculate equity
        let portfolioValue = user.cash;
        for (const pos of positions) {
            const priceData = engine.getPrice(pos.ticker);
            if (priceData) {
                portfolioValue += pos.qty * priceData.price;
            }
        }

        // Margin call if equity < 110% of short exposure
        if (portfolioValue < totalShortExposure * 1.1) {
            // Auto-cover shorts
            for (const sp of shortPositions) {
                const coverQty = Math.abs(sp.qty);
                const coverPrice = engine.getPrice(sp.ticker).ask;
                const coverTotal = coverQty * coverPrice;

                const pnl = (sp.avg_cost - coverPrice) * coverQty;
                const newCash = user.cash - coverTotal;
                stmts.updateUserCash.run(+newCash.toFixed(2), user.id);
                stmts.deletePosition.run(user.id, sp.ticker);

                const tradeId = uuid();
                stmts.insertTrade.run(tradeId, 'margin-call', user.id, sp.ticker, 'buy', coverQty, coverPrice, coverTotal, +pnl.toFixed(2), now);

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
