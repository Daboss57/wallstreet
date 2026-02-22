const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError } = require('./db');
const engine = require('./engine');
const {
    estimateExecution,
    estimateBorrowAccrual,
    recordFillMetrics,
    isExecutionRealismEnabled,
} = require('./executionModel');

let fillCallback = null;
let paused = false;
let lastDbErrorLogAt = 0;
const DEBUG_EXECUTION_DIAGNOSTICS = ['1', 'true', 'yes', 'on']
    .includes(String(process.env.DEBUG_EXECUTION_DIAGNOSTICS || 'false').toLowerCase());

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

function round(value, decimals = 2) {
    const factor = 10 ** decimals;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function safeNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getMidPrice(priceData, fallbackPrice) {
    const bid = safeNumber(priceData?.bid, 0);
    const ask = safeNumber(priceData?.ask, 0);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return safeNumber(priceData?.price, fallbackPrice);
}

function buildExecutionBreakdown(order, qty, referencePrice, midPrice, opensShortQty) {
    const tickerDef = engine.getTickerDef(order.ticker) || {};
    const priceData = engine.getPrice(order.ticker);
    const regime = engine.getCurrentRegime ? engine.getCurrentRegime() : null;
    return estimateExecution({
        tickerDef,
        side: order.side,
        qty,
        reference_price: referencePrice,
        mid_price: midPrice,
        volatility: safeNumber(priceData?.volatility, 0),
        regime,
        opens_short_qty: opensShortQty,
        apply_realism: isExecutionRealismEnabled(),
    });
}

function applyLimitGuard(breakdown, side, qty, midPrice, limitPrice) {
    if (!Number.isFinite(Number(limitPrice)) || Number(limitPrice) <= 0) return breakdown;
    const capped = { ...breakdown };
    if (side === 'buy' && capped.fill_price > limitPrice) capped.fill_price = Number(limitPrice);
    if (side === 'sell' && capped.fill_price < limitPrice) capped.fill_price = Number(limitPrice);
    capped.notional = capped.fill_price * qty;
    capped.slippage_cost = side === 'buy'
        ? Math.max(0, (capped.fill_price - midPrice) * qty)
        : Math.max(0, (midPrice - capped.fill_price) * qty);
    const referenceBase = Math.max(0.0000001, Number(midPrice) || capped.fill_price);
    capped.slippage_bps = Math.abs((capped.fill_price - referenceBase) / referenceBase) * 10000;
    const commissionBps = capped.notional > 0 ? (capped.commission / capped.notional) * 10000 : 0;
    const borrowBps = capped.notional > 0 ? (capped.borrow_cost / capped.notional) * 10000 : 0;
    capped.execution_quality_score = Math.max(
        0,
        Math.min(100, 100 - ((capped.slippage_bps * 0.6) + (commissionBps * 0.3) + (borrowBps * 0.1)))
    );
    return capped;
}

async function upsertPositionState({
    id,
    userId,
    ticker,
    qty,
    avgCost,
    openedAt,
    accruedBorrowCost,
    lastBorrowAccrualAt,
}) {
    await stmts.upsertPosition.run(
        id,
        userId,
        ticker,
        qty,
        avgCost,
        openedAt,
        accruedBorrowCost,
        lastBorrowAccrualAt
    );
}

async function accrueBorrowCosts(now) {
    if (!isExecutionRealismEnabled()) return;

    const [positions, users] = await Promise.all([
        stmts.getAllPositions.all(),
        stmts.getAllUsers.all(),
    ]);
    if (!positions || positions.length === 0) return;

    const userMap = new Map((users || []).map((u) => [u.id, { ...u, cash: safeNumber(u.cash, 0) }]));
    const regime = engine.getCurrentRegime ? engine.getCurrentRegime() : null;

    for (const position of positions) {
        const qty = safeNumber(position.qty, 0);
        if (qty >= 0) continue;

        const user = userMap.get(position.user_id);
        if (!user) continue;
        const priceData = engine.getPrice(position.ticker);
        if (!priceData) continue;

        const currentPrice = safeNumber(priceData.price, 0);
        if (currentPrice <= 0) continue;

        const lastAccrualAt = safeNumber(position.last_borrow_accrual_at, safeNumber(position.opened_at, now));
        const elapsedMs = Math.max(0, now - lastAccrualAt);
        if (elapsedMs < 30_000) continue;

        const shortNotional = Math.abs(qty) * currentPrice;
        const tickerDef = engine.getTickerDef(position.ticker) || {};
        const accrual = estimateBorrowAccrual({
            notional: shortNotional,
            borrow_apr_short: tickerDef.borrow_apr_short,
            elapsed_ms: elapsedMs,
            regime,
        });
        if (!Number.isFinite(accrual) || accrual <= 0) continue;

        const updatedCash = round(user.cash - accrual, 2);
        user.cash = updatedCash;
        await stmts.updateUserCash.run(updatedCash, position.user_id);
        await upsertPositionState({
            id: position.id,
            userId: position.user_id,
            ticker: position.ticker,
            qty,
            avgCost: safeNumber(position.avg_cost, 0),
            openedAt: safeNumber(position.opened_at, now),
            accruedBorrowCost: round(safeNumber(position.accrued_borrow_cost, 0) + accrual, 8),
            lastBorrowAccrualAt: now,
        });
    }
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
    const now = Date.now();
    try {
        await accrueBorrowCosts(now);
    } catch (error) {
        if (isDbUnavailableError(error)) {
            logMatcherDbError(error);
            return;
        }
        console.error('[Matcher] Borrow accrual failed:', error.message);
    }

    if (openOrders.length === 0) return;

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

    const referencePrice = order.side === 'buy' ? ask : bid;
    await executeFill(order, remainQty, referencePrice, now, {
        midPrice: currentPrice,
    });
}

async function checkLimitOrder(order, bid, ask, now) {
    const remainQty = order.qty - order.filled_qty;
    if (remainQty <= 0) return;

    if (order.side === 'buy' && ask <= order.limit_price) {
        await executeFill(order, remainQty, ask, now, {
            midPrice: (bid + ask) / 2,
            limitPrice: order.limit_price,
        });
    } else if (order.side === 'sell' && bid >= order.limit_price) {
        await executeFill(order, remainQty, bid, now, {
            midPrice: (bid + ask) / 2,
            limitPrice: order.limit_price,
        });
    }
}

async function checkStopOrder(order, currentPrice, now) {
    let triggered = false;
    if (order.side === 'sell' && currentPrice <= order.stop_price) triggered = true;
    if (order.side === 'buy' && currentPrice >= order.stop_price) triggered = true;
    if (!triggered) return;

    const priceData = engine.getPrice(order.ticker);
    if (!priceData) return;
    const referencePrice = order.side === 'buy' ? priceData.ask : priceData.bid;
    const remainQty = order.qty - order.filled_qty;
    await executeFill(order, remainQty, referencePrice, now, {
        midPrice: getMidPrice(priceData, referencePrice),
    });
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
        await executeFill(order, remainQty, priceData.ask, now, {
            midPrice: getMidPrice(priceData, priceData.ask),
            limitPrice: order.limit_price,
        });
    } else if (order.side === 'sell' && priceData.bid >= order.limit_price) {
        await executeFill(order, remainQty, priceData.bid, now, {
            midPrice: getMidPrice(priceData, priceData.bid),
            limitPrice: order.limit_price,
        });
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
    const referencePrice = order.side === 'buy' ? priceData.ask : priceData.bid;
    await executeFill(order, remainQty, referencePrice, now, {
        midPrice: getMidPrice(priceData, referencePrice),
    });
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
            await executeFill(order, order.qty - order.filled_qty, priceData.bid, now, {
                midPrice: getMidPrice(priceData, priceData.bid),
            });
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
            await executeFill(order, order.qty - order.filled_qty, priceData.ask, now, {
                midPrice: getMidPrice(priceData, priceData.ask),
            });
        }
    }
}

async function executeFill(order, qty, referencePrice, now, options = {}) {
    let targetQty = Math.floor(Number(qty));
    if (targetQty <= 0) return;

    const decimals = engine.getDecimals(order.ticker);
    const user = await stmts.getUserById.get(order.user_id);
    if (!user) return;
    const position = await stmts.getPosition.get(order.user_id, order.ticker);
    const currentQty = safeNumber(position?.qty, 0);
    const currentAvg = safeNumber(position?.avg_cost, 0);
    const baseOpenedAt = safeNumber(position?.opened_at, now);
    const baseAccruedBorrow = safeNumber(position?.accrued_borrow_cost, 0);
    const baseLastBorrowAccrualAt = safeNumber(position?.last_borrow_accrual_at, now);
    const priceData = engine.getPrice(order.ticker);
    const midPrice = safeNumber(options.midPrice, getMidPrice(priceData, referencePrice));

    const computeExecutionForQty = (candidateQty) => {
        const longInventory = Math.max(0, currentQty);
        const opensShortQty = order.side === 'sell'
            ? Math.max(0, candidateQty - longInventory)
            : 0;
        let breakdown = buildExecutionBreakdown(order, candidateQty, referencePrice, midPrice, opensShortQty);
        breakdown = applyLimitGuard(breakdown, order.side, candidateQty, midPrice, options.limitPrice);
        breakdown.fill_price = round(breakdown.fill_price, decimals);
        breakdown.notional = round(breakdown.fill_price * candidateQty, 8);
        breakdown.slippage_cost = round(Math.max(0, breakdown.slippage_cost), 8);
        breakdown.commission = round(Math.max(0, breakdown.commission), 8);
        breakdown.borrow_cost = round(Math.max(0, breakdown.borrow_cost), 8);
        return { opensShortQty, breakdown };
    };

    let execution = computeExecutionForQty(targetQty);
    if (order.side === 'buy') {
        while (targetQty > 0) {
            const totalRequired = (targetQty * execution.breakdown.fill_price)
                + execution.breakdown.commission
                + execution.breakdown.borrow_cost;
            if (totalRequired <= safeNumber(user.cash, 0) + 1e-6) break;
            targetQty -= 1;
            if (targetQty <= 0) {
                await stmts.cancelOrder.run(now, order.id);
                return;
            }
            execution = computeExecutionForQty(targetQty);
        }
    }

    const fillPrice = round(execution.breakdown.fill_price, decimals);
    const fillTotal = round(targetQty * fillPrice, 8);
    const commission = round(execution.breakdown.commission, 8);
    const immediateBorrowCost = round(execution.breakdown.borrow_cost, 8);

    const cashDelta = order.side === 'buy'
        ? -(fillTotal + commission + immediateBorrowCost)
        : (fillTotal - commission - immediateBorrowCost);
    const newCash = round(safeNumber(user.cash, 0) + cashDelta, 2);
    await stmts.updateUserCash.run(newCash, order.user_id);

    let pnl = 0;
    let realizedBorrowFromPosition = 0;
    let nextQty = currentQty;
    let nextAvgCost = currentAvg;
    let nextOpenedAt = baseOpenedAt;
    let nextAccruedBorrow = baseAccruedBorrow;
    let nextLastBorrowAccrualAt = baseLastBorrowAccrualAt;
    let deletePosition = false;

    if (order.side === 'buy') {
        if (currentQty < 0) {
            const shortQty = Math.abs(currentQty);
            const closedQty = Math.min(targetQty, shortQty);
            pnl += closedQty * (currentAvg - fillPrice);
            if (shortQty > 0 && baseAccruedBorrow > 0) {
                realizedBorrowFromPosition = round(baseAccruedBorrow * (closedQty / shortQty), 8);
            }
            nextAccruedBorrow = round(Math.max(0, baseAccruedBorrow - realizedBorrowFromPosition), 8);
            nextQty = currentQty + targetQty;
            if (nextQty > 0) {
                nextAvgCost = fillPrice;
                nextOpenedAt = now;
                nextAccruedBorrow = 0;
                nextLastBorrowAccrualAt = now;
            } else if (nextQty === 0) {
                deletePosition = true;
            } else {
                nextAvgCost = currentAvg;
                nextOpenedAt = baseOpenedAt;
                nextLastBorrowAccrualAt = now;
            }
        } else if (currentQty > 0) {
            nextQty = currentQty + targetQty;
            nextAvgCost = nextQty !== 0
                ? ((currentQty * currentAvg) + (targetQty * fillPrice)) / nextQty
                : fillPrice;
            nextOpenedAt = baseOpenedAt;
            nextAccruedBorrow = 0;
            nextLastBorrowAccrualAt = now;
        } else {
            nextQty = targetQty;
            nextAvgCost = fillPrice;
            nextOpenedAt = now;
            nextAccruedBorrow = 0;
            nextLastBorrowAccrualAt = now;
        }
    } else if (currentQty > 0) {
        const closedQty = Math.min(targetQty, currentQty);
        pnl += closedQty * (fillPrice - currentAvg);
        nextQty = currentQty - targetQty;
        if (nextQty > 0) {
            nextAvgCost = currentAvg;
            nextOpenedAt = baseOpenedAt;
        } else if (nextQty === 0) {
            deletePosition = true;
        } else {
            nextAvgCost = fillPrice;
            nextOpenedAt = now;
            nextAccruedBorrow = 0;
            nextLastBorrowAccrualAt = now;
        }
    } else if (currentQty < 0) {
        const currentShortQty = Math.abs(currentQty);
        nextQty = currentQty - targetQty;
        const nextShortQty = Math.abs(nextQty);
        nextAvgCost = nextShortQty > 0
            ? (((currentShortQty * currentAvg) + (targetQty * fillPrice)) / nextShortQty)
            : fillPrice;
        nextOpenedAt = baseOpenedAt;
        nextAccruedBorrow = baseAccruedBorrow;
        nextLastBorrowAccrualAt = now;
    } else {
        nextQty = -targetQty;
        nextAvgCost = fillPrice;
        nextOpenedAt = now;
        nextAccruedBorrow = 0;
        nextLastBorrowAccrualAt = now;
    }

    const tradeBorrowCost = round(immediateBorrowCost + realizedBorrowFromPosition, 8);
    const netPnl = round(pnl - commission - tradeBorrowCost, 8);

    if (deletePosition || Math.abs(nextQty) < 0.0000001) {
        await stmts.deletePosition.run(order.user_id, order.ticker);
    } else {
        await upsertPositionState({
            id: position?.id || uuid(),
            userId: order.user_id,
            ticker: order.ticker,
            qty: round(nextQty, 8),
            avgCost: round(nextAvgCost, 8),
            openedAt: nextOpenedAt,
            accruedBorrowCost: nextQty < 0 ? round(nextAccruedBorrow, 8) : 0,
            lastBorrowAccrualAt: nextLastBorrowAccrualAt,
        });
    }

    const tradeId = uuid();
    await stmts.insertTrade.run(
        tradeId,
        order.id,
        order.user_id,
        order.ticker,
        order.side,
        targetQty,
        fillPrice,
        fillTotal,
        round(netPnl, 2),
        now,
        round(execution.breakdown.mid_price, 8),
        round(execution.breakdown.slippage_bps, 6),
        round(execution.breakdown.slippage_cost, 8),
        round(commission, 8),
        round(tradeBorrowCost, 8),
        round(execution.breakdown.execution_quality_score, 6),
        execution.breakdown.regime
    );

    const newFilledQty = order.filled_qty + targetQty;
    const status = newFilledQty >= order.qty ? 'filled' : 'partial';
    await stmts.updateOrderStatus.run(status, newFilledQty, fillPrice, now, order.id);

    if (order.oco_id) {
        await stmts.cancelOcoOrders.run(now, order.oco_id, order.id);
    }

    engine.addOrderFlowImpact(order.ticker, order.side, fillTotal);
    recordFillMetrics({
        timestamp: now,
        slippage_bps: execution.breakdown.slippage_bps,
        execution_quality_score: execution.breakdown.execution_quality_score,
    });
    if (DEBUG_EXECUTION_DIAGNOSTICS) {
        console.debug('[ExecutionDiagnostics]', {
            user_id: order.user_id,
            order_id: order.id,
            ticker: order.ticker,
            side: order.side,
            qty: targetQty,
            fill_price: fillPrice,
            mid_price: round(execution.breakdown.mid_price, 8),
            slippage_bps: round(execution.breakdown.slippage_bps, 6),
            slippage_cost: round(execution.breakdown.slippage_cost, 8),
            commission: round(commission, 8),
            borrow_cost: round(tradeBorrowCost, 8),
            execution_quality_score: round(execution.breakdown.execution_quality_score, 6),
            regime: execution.breakdown.regime,
        });
    }

    if (fillCallback) {
        fillCallback(order.user_id, {
            type: 'fill',
            orderId: order.id,
            tradeId,
            ticker: order.ticker,
            side: order.side,
            qty: targetQty,
            price: fillPrice,
            total: round(fillTotal, 2),
            fee: round(commission + tradeBorrowCost, 2),
            commission: round(commission, 2),
            borrow_cost: round(tradeBorrowCost, 2),
            slippage_bps: round(execution.breakdown.slippage_bps, 4),
            slippage_cost: round(execution.breakdown.slippage_cost, 2),
            execution_quality_score: round(execution.breakdown.execution_quality_score, 2),
            net_pnl_effect: round(netPnl, 2),
            regime: execution.breakdown.regime,
            pnl: round(netPnl, 2),
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
            const priceData = engine.getPrice(shortPosition.ticker);
            const referencePrice = priceData?.ask;
            if (!referencePrice) continue;

            const execution = buildExecutionBreakdown(
                { side: 'buy', ticker: shortPosition.ticker },
                coverQty,
                referencePrice,
                getMidPrice(priceData, referencePrice),
                0
            );
            const coverPrice = round(execution.fill_price, engine.getDecimals(shortPosition.ticker));
            const coverTotal = round(coverQty * coverPrice, 8);
            const commission = round(execution.commission, 8);
            const immediateBorrowCost = round(execution.borrow_cost, 8);
            const accruedBorrow = round(safeNumber(shortPosition.accrued_borrow_cost, 0), 8);
            const tradeBorrowCost = round(immediateBorrowCost + accruedBorrow, 8);
            const pnl = round(
                ((shortPosition.avg_cost - coverPrice) * coverQty) - commission - tradeBorrowCost,
                8
            );
            userCash = round(userCash - coverTotal - commission - immediateBorrowCost, 2);

            await stmts.updateUserCash.run(userCash, user.id);
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
                now,
                round(execution.mid_price, 8),
                round(execution.slippage_bps, 6),
                round(execution.slippage_cost, 8),
                round(commission, 8),
                round(tradeBorrowCost, 8),
                round(execution.execution_quality_score, 6),
                execution.regime
            );
            recordFillMetrics({
                timestamp: now,
                slippage_bps: execution.slippage_bps,
                execution_quality_score: execution.execution_quality_score,
            });

            if (fillCallback) {
                fillCallback(user.id, {
                    type: 'margin_call',
                    ticker: shortPosition.ticker,
                    qty: coverQty,
                    price: coverPrice,
                    commission: round(commission, 2),
                    borrow_cost: round(tradeBorrowCost, 2),
                    slippage_bps: round(execution.slippage_bps, 4),
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
