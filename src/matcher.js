const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError } = require('./db');
const engine = require('./engine');

function boundedFloat(value, fallback, min, max) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

const TRADING_FEE_RATE = boundedFloat(process.env.TRADING_FEE_RATE, 0.0025, 0, 0.05);
const MIN_TRADE_FEE = boundedFloat(process.env.MIN_TRADE_FEE, 1.0, 0, 1000);

let fillCallback = null;
let paused = false;
let lastDbErrorLogAt = 0;

function setFillCallback(callback) {
    fillCallback = callback;
}

function setPaused(value, reason = 'db_unavailable') {
    if (paused === value) return;
    paused = value;
    if (paused) {
        console.warn(`[Matcher] Paused (${reason})`);
    } else {
        console.log('[Matcher] Resumed');
    }
}

function isPaused() {
    return paused;
}

function logMatcherDbError(error) {
    const now = Date.now();
    if (now - lastDbErrorLogAt < 15000) return;
    lastDbErrorLogAt = now;
    console.error('[Matcher] DB error:', error.message);
}

async function matchAll() {
    if (paused) return;

    let openOrders = [];
    try {
        openOrders = await stmts.getAllOpenOrders.all();
    } catch (error) {
        if (isDbUnavailableError(error)) {
            logMatcherDbError(error);
            return;
        }
        throw error;
    }
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
                    await checkLimitOrder(order, bid, ask, now);
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
                default:
                    break;
            }
        } catch (error) {
            if (isDbUnavailableError(error)) {
                logMatcherDbError(error);
                return;
            }
            console.error(`[Matcher] Error processing order ${order.id}:`, error.message);
        }
    }

    await checkMarginCalls(now);
}

async function executeMarketOrder(order, currentPrice, bid, ask, now) {
    const remainQty = order.qty - order.filled_qty;
    if (remainQty <= 0) return;

    const slippageBps = Math.min(remainQty * 0.5, 50);
    const slippage = currentPrice * (slippageBps / 10000);
    let fillPrice = order.side === 'buy' ? ask + slippage : bid - slippage;
    fillPrice = Math.max(fillPrice, 0.01);

    await executeFill(order, remainQty, fillPrice, now);
}

async function checkLimitOrder(order, bid, ask, now) {
    const remainQty = order.qty - order.filled_qty;
    if (remainQty <= 0) return;

    if (order.side === 'buy' && ask <= order.limit_price) {
        const fillPrice = Math.min(ask, order.limit_price);
        await executeFill(order, remainQty, fillPrice, now);
    } else if (order.side === 'sell' && bid >= order.limit_price) {
        const fillPrice = Math.max(bid, order.limit_price);
        await executeFill(order, remainQty, fillPrice, now);
    }
}

async function checkStopOrder(order, currentPrice, now) {
    let triggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) triggered = true;
    if (!triggered) return;

    const priceData = engine.getPrice(order.ticker);
    if (!priceData) return;
    const fillPrice = order.side === 'buy' ? priceData.ask : priceData.bid;
    const remainQty = order.qty - order.filled_qty;
    await executeFill(order, remainQty, fillPrice, now);
}

async function checkStopLimitOrder(order, currentPrice, now) {
    let stopTriggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) stopTriggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) stopTriggered = true;
    if (!stopTriggered) return;

    const priceData = engine.getPrice(order.ticker);
    if (!priceData) return;
    const remainQty = order.qty - order.filled_qty;
    if (remainQty <= 0) return;

    if (order.side === 'buy' && priceData.ask <= order.limit_price) {
        await executeFill(order, remainQty, Math.min(priceData.ask, order.limit_price), now);
    } else if (order.side === 'sell' && priceData.bid >= order.limit_price) {
        await executeFill(order, remainQty, Math.max(priceData.bid, order.limit_price), now);
    }
}

async function checkTakeProfitOrder(order, currentPrice, now) {
    let triggered = false;
    if (order.side === 'sell' && currentPrice >= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice <= order.stop_price) triggered = true;
    if (!triggered) return;

    const priceData = engine.getPrice(order.ticker);
    if (!priceData) return;
    const remainQty = order.qty - order.filled_qty;
    await executeFill(order, remainQty, order.side === 'buy' ? priceData.ask : priceData.bid, now);
}

async function checkTrailingStop(order, currentPrice, now) {
    if (!order.trail_pct) return;

    let trailHigh = order.trail_high || currentPrice;
    if (order.side === 'sell') {
        if (currentPrice > trailHigh) {
            trailHigh = currentPrice;
            await stmts.updateOrderTrailHigh.run(trailHigh, order.id);
        }
        const stopPrice = trailHigh * (1 - order.trail_pct / 100);
        if (currentPrice <= stopPrice) {
            const priceData = engine.getPrice(order.ticker);
            if (!priceData) return;
            await executeFill(order, order.qty - order.filled_qty, priceData.bid, now);
        }
    } else {
        if (currentPrice < trailHigh) {
            trailHigh = currentPrice;
            await stmts.updateOrderTrailHigh.run(trailHigh, order.id);
        }
        const stopPrice = trailHigh * (1 + order.trail_pct / 100);
        if (currentPrice >= stopPrice) {
            const priceData = engine.getPrice(order.ticker);
            if (!priceData) return;
            await executeFill(order, order.qty - order.filled_qty, priceData.ask, now);
        }
    }
}

async function executeFill(order, qty, price, now) {
    if (qty <= 0) return;

    const decimals = engine.getDecimals(order.ticker);
    price = +price.toFixed(decimals);

    const user = await stmts.getUserById.get(order.user_id);
    if (!user) return;

    if (order.side === 'buy') {
        const totalRequired = qty * price;
        const estimatedFee = Math.max(MIN_TRADE_FEE, totalRequired * TRADING_FEE_RATE);
        if (totalRequired > user.cash) {
            qty = Math.floor((user.cash - MIN_TRADE_FEE) / (price * (1 + TRADING_FEE_RATE)));
            if (qty <= 0) {
                await stmts.cancelOrder.run(now, order.id);
                return;
            }
        } else if (totalRequired + estimatedFee > user.cash) {
            qty = Math.floor((user.cash - MIN_TRADE_FEE) / (price * (1 + TRADING_FEE_RATE)));
            if (qty <= 0) {
                await stmts.cancelOrder.run(now, order.id);
                return;
            }
        }
    }

    const fillTotal = qty * price;
    const fee = Math.max(MIN_TRADE_FEE, fillTotal * TRADING_FEE_RATE);
    const newCash = order.side === 'buy' ? user.cash - fillTotal - fee : user.cash + fillTotal - fee;
    await stmts.updateUserCash.run(+newCash.toFixed(2), order.user_id);

    const position = await stmts.getPosition.get(order.user_id, order.ticker);
    let pnl = 0;

    if (order.side === 'buy') {
        if (position) {
            const newQty = position.qty + qty;
            const newAvgCost = newQty !== 0 ? ((position.qty * position.avg_cost + qty * price) / newQty) : 0;
            await stmts.upsertPosition.run(
                position.id,
                order.user_id,
                order.ticker,
                newQty,
                +newAvgCost.toFixed(decimals),
                position.opened_at
            );
        } else {
            await stmts.upsertPosition.run(uuid(), order.user_id, order.ticker, qty, price, now);
        }
    } else if (position && position.qty > 0) {
        pnl = (price - position.avg_cost) * Math.min(qty, position.qty) - fee;
        const newQty = position.qty - qty;
        if (Math.abs(newQty) < 0.0001) {
            await stmts.deletePosition.run(order.user_id, order.ticker);
        } else {
            await stmts.upsertPosition.run(
                position.id,
                order.user_id,
                order.ticker,
                newQty,
                position.avg_cost,
                position.opened_at
            );
        }
    } else {
        if (position) {
            await stmts.upsertPosition.run(
                position.id,
                order.user_id,
                order.ticker,
                position.qty - qty,
                position.avg_cost,
                position.opened_at
            );
        } else {
            await stmts.upsertPosition.run(uuid(), order.user_id, order.ticker, -qty, price, now);
        }
    }

    const tradeId = uuid();
    await stmts.insertTrade.run(
        tradeId,
        order.id,
        order.user_id,
        order.ticker,
        order.side,
        qty,
        price,
        fillTotal,
        +pnl.toFixed(2),
        now
    );

    const newFilledQty = order.filled_qty + qty;
    const status = newFilledQty >= order.qty ? 'filled' : 'partial';
    await stmts.updateOrderStatus.run(status, newFilledQty, price, now, order.id);

    if (order.oco_id) {
        await stmts.cancelOcoOrders.run(now, order.oco_id, order.id);
    }

    engine.addOrderFlowImpact(order.ticker, order.side, fillTotal);

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
            fee: +fee.toFixed(2),
            pnl: +pnl.toFixed(2),
            timestamp: now,
        });
    }
}

async function checkMarginCalls(now) {
    const users = await stmts.getAllUsers.all();
    for (const user of users) {
        const positions = await stmts.getUserPositions.all(user.id);
        let totalShortExposure = 0;
        const shortPositions = [];

        for (const position of positions) {
            if (position.qty < 0) {
                const priceData = engine.getPrice(position.ticker);
                if (priceData) {
                    const exposure = Math.abs(position.qty) * priceData.price;
                    totalShortExposure += exposure;
                    shortPositions.push({ ...position, currentPrice: priceData.price, exposure });
                }
            }
        }

        if (totalShortExposure === 0) continue;

        let portfolioValue = user.cash;
        for (const position of positions) {
            const priceData = engine.getPrice(position.ticker);
            if (priceData) {
                portfolioValue += position.qty * priceData.price;
            }
        }

        if (portfolioValue >= totalShortExposure * 1.1) continue;

        let userCash = user.cash;
        for (const shortPosition of shortPositions) {
            const coverQty = Math.abs(shortPosition.qty);
            const coverPrice = engine.getPrice(shortPosition.ticker)?.ask;
            if (!coverPrice) continue;

            const coverTotal = coverQty * coverPrice;
            const pnl = (shortPosition.avg_cost - coverPrice) * coverQty;
            userCash -= coverTotal;

            await stmts.updateUserCash.run(+userCash.toFixed(2), user.id);
            await stmts.deletePosition.run(user.id, shortPosition.ticker);

            const tradeId = uuid();
            await stmts.insertTrade.run(
                tradeId,
                'margin-call',
                user.id,
                shortPosition.ticker,
                'buy',
                coverQty,
                coverPrice,
                coverTotal,
                +pnl.toFixed(2),
                now
            );

            if (fillCallback) {
                fillCallback(user.id, {
                    type: 'margin_call',
                    ticker: shortPosition.ticker,
                    qty: coverQty,
                    price: coverPrice,
                    pnl: +pnl.toFixed(2),
                    timestamp: now,
                });
            }
        }
    }
}

module.exports = {
    matchAll,
    setFillCallback,
    setPaused,
    isPaused,
};
