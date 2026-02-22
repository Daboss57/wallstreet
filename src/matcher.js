const { v4: uuid } = require('uuid');
const { stmts, isDbUnavailableError, runInTransaction } = require('./db');
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
    client = null,
}) {
    const params = [
        id,
        userId,
        ticker,
        qty,
        avgCost,
        openedAt,
        accruedBorrowCost,
        lastBorrowAccrualAt,
    ];
    if (client) {
        await stmts.upsertPosition.runTx(client, ...params);
    } else {
        await stmts.upsertPosition.run(...params);
    }
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
        await runInTransaction(`matcher_borrow_accrual_${position.id || `${position.user_id}_${position.ticker}`}`, async (client) => {
            const lockedUser = await stmts.getUserByIdForUpdate.getTx(client, position.user_id);
            if (!lockedUser) return;
            const lockedPosition = await stmts.getPositionForUpdate.getTx(client, position.user_id, position.ticker);
            if (!lockedPosition) return;
            const lockedQty = safeNumber(lockedPosition.qty, 0);
            if (lockedQty >= 0) return;

            const lockedLastAccrualAt = safeNumber(
                lockedPosition.last_borrow_accrual_at,
                safeNumber(lockedPosition.opened_at, now)
            );
            const lockedElapsedMs = Math.max(0, now - lockedLastAccrualAt);
            if (lockedElapsedMs < 30_000) return;

            const livePriceData = engine.getPrice(position.ticker);
            const livePrice = safeNumber(livePriceData?.price, 0);
            if (livePrice <= 0) return;

            const lockedTickerDef = engine.getTickerDef(position.ticker) || {};
            const lockedAccrual = estimateBorrowAccrual({
                notional: Math.abs(lockedQty) * livePrice,
                borrow_apr_short: lockedTickerDef.borrow_apr_short,
                elapsed_ms: lockedElapsedMs,
                regime,
            });
            if (!Number.isFinite(lockedAccrual) || lockedAccrual <= 0) return;

            const updatedCash = round(safeNumber(lockedUser.cash, 0) - lockedAccrual, 2);
            await stmts.updateUserCash.runTx(client, updatedCash, position.user_id);
            await upsertPositionState({
                id: lockedPosition.id,
                userId: position.user_id,
                ticker: position.ticker,
                qty: lockedQty,
                avgCost: safeNumber(lockedPosition.avg_cost, 0),
                openedAt: safeNumber(lockedPosition.opened_at, now),
                accruedBorrowCost: round(safeNumber(lockedPosition.accrued_borrow_cost, 0) + lockedAccrual, 8),
                lastBorrowAccrualAt: now,
                client,
            });
            user.cash = updatedCash;
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
    let result = null;
    await runInTransaction(`matcher_execute_fill_${order.id}`, async (client) => {
        const lockedOrder = await stmts.getOrderByIdForUpdate.getTx(client, order.id);
        if (!lockedOrder || lockedOrder.status !== 'open') return;

        const remainingQty = Math.floor(safeNumber(lockedOrder.qty, 0) - safeNumber(lockedOrder.filled_qty, 0));
        let targetQty = Math.min(Math.floor(Number(qty)), remainingQty);
        if (targetQty <= 0) return;

        const decimals = engine.getDecimals(lockedOrder.ticker);
        const user = await stmts.getUserByIdForUpdate.getTx(client, lockedOrder.user_id);
        if (!user) return;
        const position = await stmts.getPositionForUpdate.getTx(client, lockedOrder.user_id, lockedOrder.ticker);
        const currentQty = safeNumber(position?.qty, 0);
        const currentAvg = safeNumber(position?.avg_cost, 0);
        const baseOpenedAt = safeNumber(position?.opened_at, now);
        const baseAccruedBorrow = safeNumber(position?.accrued_borrow_cost, 0);
        const baseLastBorrowAccrualAt = safeNumber(position?.last_borrow_accrual_at, now);
        const priceData = engine.getPrice(lockedOrder.ticker);
        const midPrice = safeNumber(options.midPrice, getMidPrice(priceData, referencePrice));

        const computeExecutionForQty = (candidateQty) => {
            const longInventory = Math.max(0, currentQty);
            const opensShortQty = lockedOrder.side === 'sell'
                ? Math.max(0, candidateQty - longInventory)
                : 0;
            let breakdown = buildExecutionBreakdown(lockedOrder, candidateQty, referencePrice, midPrice, opensShortQty);
            breakdown = applyLimitGuard(breakdown, lockedOrder.side, candidateQty, midPrice, options.limitPrice);
            breakdown.fill_price = round(breakdown.fill_price, decimals);
            breakdown.notional = round(breakdown.fill_price * candidateQty, 8);
            breakdown.slippage_cost = round(Math.max(0, breakdown.slippage_cost), 8);
            breakdown.commission = round(Math.max(0, breakdown.commission), 8);
            breakdown.borrow_cost = round(Math.max(0, breakdown.borrow_cost), 8);
            return { opensShortQty, breakdown };
        };

        let execution = computeExecutionForQty(targetQty);
        if (lockedOrder.side === 'buy') {
            while (targetQty > 0) {
                const totalRequired = (targetQty * execution.breakdown.fill_price) + execution.breakdown.commission;
                if (totalRequired <= safeNumber(user.cash, 0) + 1e-6) break;
                targetQty -= 1;
                if (targetQty <= 0) {
                    await stmts.cancelOrder.runTx(client, now, lockedOrder.id);
                    return;
                }
                execution = computeExecutionForQty(targetQty);
            }
        }

        const fillPrice = round(execution.breakdown.fill_price, decimals);
        const fillTotal = round(targetQty * fillPrice, 8);
        const commission = round(execution.breakdown.commission, 8);

        // Borrow is accrued over elapsed time; no full-day upfront debit on open short.
        const immediateBorrowCost = 0;
        const cashDelta = lockedOrder.side === 'buy'
            ? -(fillTotal + commission + immediateBorrowCost)
            : (fillTotal - commission - immediateBorrowCost);
        const newCash = round(safeNumber(user.cash, 0) + cashDelta, 2);

        let pnl = 0;
        let realizedBorrowFromPosition = 0;
        let nextQty = currentQty;
        let nextAvgCost = currentAvg;
        let nextOpenedAt = baseOpenedAt;
        let nextAccruedBorrow = baseAccruedBorrow;
        let nextLastBorrowAccrualAt = baseLastBorrowAccrualAt;
        let deletePosition = false;

        if (lockedOrder.side === 'buy') {
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

        await stmts.updateUserCash.runTx(client, newCash, lockedOrder.user_id);

        if (deletePosition || Math.abs(nextQty) < 0.0000001) {
            await stmts.deletePosition.runTx(client, lockedOrder.user_id, lockedOrder.ticker);
        } else {
            await upsertPositionState({
                id: position?.id || uuid(),
                userId: lockedOrder.user_id,
                ticker: lockedOrder.ticker,
                qty: round(nextQty, 8),
                avgCost: round(nextAvgCost, 8),
                openedAt: nextOpenedAt,
                accruedBorrowCost: nextQty < 0 ? round(nextAccruedBorrow, 8) : 0,
                lastBorrowAccrualAt: nextLastBorrowAccrualAt,
                client,
            });
        }

        const tradeId = uuid();
        await stmts.insertTrade.runTx(
            client,
            tradeId,
            lockedOrder.id,
            lockedOrder.user_id,
            lockedOrder.ticker,
            lockedOrder.side,
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

        const newFilledQty = safeNumber(lockedOrder.filled_qty, 0) + targetQty;
        const status = newFilledQty >= safeNumber(lockedOrder.qty, 0) ? 'filled' : 'partial';
        await stmts.updateOrderStatus.runTx(client, status, newFilledQty, fillPrice, now, lockedOrder.id);

        if (lockedOrder.oco_id) {
            await stmts.cancelOcoOrders.runTx(client, now, lockedOrder.oco_id, lockedOrder.id);
        }

        result = {
            userId: lockedOrder.user_id,
            orderId: lockedOrder.id,
            tradeId,
            ticker: lockedOrder.ticker,
            side: lockedOrder.side,
            qty: targetQty,
            fillPrice,
            fillTotal,
            commission,
            tradeBorrowCost,
            slippage_bps: execution.breakdown.slippage_bps,
            slippage_cost: execution.breakdown.slippage_cost,
            execution_quality_score: execution.breakdown.execution_quality_score,
            netPnl,
            regime: execution.breakdown.regime,
            mid_price: execution.breakdown.mid_price,
        };
    });

    if (!result) return;

    engine.addOrderFlowImpact(result.ticker, result.side, result.fillTotal);
    recordFillMetrics({
        timestamp: now,
        slippage_bps: result.slippage_bps,
        execution_quality_score: result.execution_quality_score,
    });
    if (DEBUG_EXECUTION_DIAGNOSTICS) {
        console.debug('[ExecutionDiagnostics]', {
            user_id: result.userId,
            order_id: result.orderId,
            ticker: result.ticker,
            side: result.side,
            qty: result.qty,
            fill_price: result.fillPrice,
            mid_price: round(result.mid_price, 8),
            slippage_bps: round(result.slippage_bps, 6),
            slippage_cost: round(result.slippage_cost, 8),
            commission: round(result.commission, 8),
            borrow_cost: round(result.tradeBorrowCost, 8),
            execution_quality_score: round(result.execution_quality_score, 6),
            regime: result.regime,
        });
    }

    if (fillCallback) {
        fillCallback(result.userId, {
            type: 'fill',
            orderId: result.orderId,
            tradeId: result.tradeId,
            ticker: result.ticker,
            side: result.side,
            qty: result.qty,
            price: result.fillPrice,
            total: round(result.fillTotal, 2),
            fee: round(result.commission + result.tradeBorrowCost, 2),
            commission: round(result.commission, 2),
            borrow_cost: round(result.tradeBorrowCost, 2),
            slippage_bps: round(result.slippage_bps, 4),
            slippage_cost: round(result.slippage_cost, 2),
            execution_quality_score: round(result.execution_quality_score, 2),
            net_pnl_effect: round(result.netPnl, 2),
            regime: result.regime,
            pnl: round(result.netPnl, 2),
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

        for (const shortPosition of shortPositions) {
            let liquidation = null;
            await runInTransaction(`matcher_margin_call_${user.id}_${shortPosition.ticker}_${now}`, async (client) => {
                const lockedUser = await stmts.getUserByIdForUpdate.getTx(client, user.id);
                if (!lockedUser) return;
                const lockedPosition = await stmts.getPositionForUpdate.getTx(client, user.id, shortPosition.ticker);
                if (!lockedPosition) return;

                const lockedQty = safeNumber(lockedPosition.qty, 0);
                if (lockedQty >= 0) return;

                const coverQty = Math.abs(lockedQty);
                const priceData = engine.getPrice(shortPosition.ticker);
                const referencePrice = priceData?.ask;
                if (!referencePrice) return;

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
                // Borrow is charged via elapsed accrual, not a one-day upfront debit.
                const immediateBorrowCost = 0;
                const accruedBorrow = round(safeNumber(lockedPosition.accrued_borrow_cost, 0), 8);
                const tradeBorrowCost = round(immediateBorrowCost + accruedBorrow, 8);
                const pnl = round(
                    ((safeNumber(lockedPosition.avg_cost, 0) - coverPrice) * coverQty) - commission - tradeBorrowCost,
                    8
                );
                const nextCash = round(
                    safeNumber(lockedUser.cash, 0) - coverTotal - commission - immediateBorrowCost,
                    2
                );

                await stmts.updateUserCash.runTx(client, nextCash, user.id);
                await stmts.deletePosition.runTx(client, user.id, shortPosition.ticker);

                const tradeId = uuid();
                await stmts.insertTrade.runTx(
                    client,
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
                liquidation = {
                    ticker: shortPosition.ticker,
                    qty: coverQty,
                    price: coverPrice,
                    commission,
                    tradeBorrowCost,
                    slippage_bps: execution.slippage_bps,
                    pnl,
                    execution_quality_score: execution.execution_quality_score,
                };
            });

            if (!liquidation) continue;

            recordFillMetrics({
                timestamp: now,
                slippage_bps: liquidation.slippage_bps,
                execution_quality_score: liquidation.execution_quality_score,
            });

            if (fillCallback) {
                fillCallback(user.id, {
                    type: 'margin_call',
                    ticker: liquidation.ticker,
                    qty: liquidation.qty,
                    price: liquidation.price,
                    commission: round(liquidation.commission, 2),
                    borrow_cost: round(liquidation.tradeBorrowCost, 2),
                    slippage_bps: round(liquidation.slippage_bps, 4),
                    pnl: +liquidation.pnl.toFixed(2),
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
