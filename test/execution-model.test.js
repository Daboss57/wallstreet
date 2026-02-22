const test = require('node:test');
const assert = require('node:assert/strict');
const {
    estimateExecution,
    estimateBorrowAccrual,
    estimateOrder,
} = require('../src/executionModel');

const TICKER_DEF = {
    class: 'Stock',
    avg_daily_dollar_volume: 1_000_000_000,
    base_spread_bps: 2,
    impact_coeff: 60,
    commission_bps: 1,
    commission_min_usd: 0.01,
    borrow_apr_short: 0.03,
};

test('execution model sets buy fill above and sell fill below reference', () => {
    const buy = estimateExecution({
        tickerDef: TICKER_DEF,
        side: 'buy',
        qty: 100,
        reference_price: 100,
        mid_price: 100,
        volatility: 0.02,
        regime: { regime: 'normal', liquidity_mult: 1, vol_mult: 1, borrow_mult: 1 },
        opens_short_qty: 0,
        apply_realism: true,
    });
    const sell = estimateExecution({
        tickerDef: TICKER_DEF,
        side: 'sell',
        qty: 100,
        reference_price: 100,
        mid_price: 100,
        volatility: 0.02,
        regime: { regime: 'normal', liquidity_mult: 1, vol_mult: 1, borrow_mult: 1 },
        opens_short_qty: 0,
        apply_realism: true,
    });

    assert.ok(buy.fill_price > 100);
    assert.ok(sell.fill_price < 100);
    assert.ok(buy.slippage_cost >= 0);
    assert.ok(sell.slippage_cost >= 0);
});

test('execution costs increase with order size', () => {
    const small = estimateExecution({
        tickerDef: TICKER_DEF,
        side: 'buy',
        qty: 10,
        reference_price: 100,
        mid_price: 100,
        volatility: 0.015,
        regime: { regime: 'normal', liquidity_mult: 1, vol_mult: 1, borrow_mult: 1 },
        opens_short_qty: 0,
        apply_realism: true,
    });
    const large = estimateExecution({
        tickerDef: TICKER_DEF,
        side: 'buy',
        qty: 2000,
        reference_price: 100,
        mid_price: 100,
        volatility: 0.015,
        regime: { regime: 'normal', liquidity_mult: 1, vol_mult: 1, borrow_mult: 1 },
        opens_short_qty: 0,
        apply_realism: true,
    });

    assert.ok(large.slippage_bps > small.slippage_bps);
    assert.ok(large.total_cost > small.total_cost);
});

test('commission minimum applies on tiny notionals', () => {
    const tiny = estimateExecution({
        tickerDef: {
            ...TICKER_DEF,
            commission_bps: 1,
            commission_min_usd: 0.25,
        },
        side: 'buy',
        qty: 1,
        reference_price: 1,
        mid_price: 1,
        volatility: 0.01,
        regime: { regime: 'normal', liquidity_mult: 1, vol_mult: 1, borrow_mult: 1 },
        opens_short_qty: 0,
        apply_realism: true,
    });

    assert.equal(tiny.commission, 0.25);
});

test('borrow accrual scales with elapsed time', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const halfDay = estimateBorrowAccrual({
        notional: 10000,
        borrow_apr_short: 0.0365,
        elapsed_ms: dayMs / 2,
        regime: { regime: 'normal', borrow_mult: 1 },
    });
    const fullDay = estimateBorrowAccrual({
        notional: 10000,
        borrow_apr_short: 0.0365,
        elapsed_ms: dayMs,
        regime: { regime: 'normal', borrow_mult: 1 },
    });

    assert.ok(fullDay > halfDay);
    assert.ok(Math.abs((fullDay / Math.max(halfDay, 1e-9)) - 2) < 0.01);
});

test('estimateOrder exposes expected execution estimate fields', () => {
    const estimate = estimateOrder({
        tickerDef: TICKER_DEF,
        side: 'sell',
        qty: 250,
        reference_price: 50,
        mid_price: 50,
        volatility: 0.02,
        opens_short_qty: 250,
        regime: { regime: 'tight_liquidity', liquidity_mult: 1.45, vol_mult: 1.15, borrow_mult: 1.2 },
    });

    assert.ok(Object.hasOwn(estimate, 'est_slippage_bps'));
    assert.ok(Object.hasOwn(estimate, 'est_slippage_cost'));
    assert.ok(Object.hasOwn(estimate, 'est_commission'));
    assert.ok(Object.hasOwn(estimate, 'est_borrow_day'));
    assert.ok(Object.hasOwn(estimate, 'est_total_cost'));
    assert.ok(estimate.est_total_cost >= 0);
});
