const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeCapitalTransactions,
    sumNetCapital,
    sumUnits,
    cumulativeUnitsAt,
    latestNavPerUnitAt,
    buildInvestorPerformanceHistory,
    calculatePeriodReturn,
    computeReturnPct,
    computeFundReturnPct,
    summarizeTradeLifecycle,
    computeReconciliation,
} = require('../src/metrics/fundMetrics');

test('normalizeCapitalTransactions infers units_delta when missing and sorts by created_at', () => {
    const tx = normalizeCapitalTransactions([
        { type: 'withdrawal', amount: 25, created_at: 2000, nav_per_unit: 2 },
        { type: 'deposit', amount: 100, created_at: 1000, nav_per_unit: 2 },
    ]);
    assert.equal(tx.length, 2);
    assert.equal(tx[0].type, 'deposit');
    assert.equal(tx[0].unitsDelta, 50);
    assert.equal(tx[1].type, 'withdrawal');
    assert.equal(tx[1].unitsDelta, -12.5);
});

test('capital and units aggregations stay consistent', () => {
    const tx = normalizeCapitalTransactions([
        { type: 'deposit', amount: 150, units_delta: 120, created_at: 1000 },
        { type: 'withdrawal', amount: 40, units_delta: -32, created_at: 2000 },
    ]);
    assert.equal(sumNetCapital(tx), 110);
    assert.equal(sumUnits(tx), 88);
    assert.equal(cumulativeUnitsAt(tx, 1500), 120);
    assert.equal(cumulativeUnitsAt(tx, 2500), 88);
});

test('performance history uses units x nav_per_unit and supports period return calculation', () => {
    const tx = normalizeCapitalTransactions([
        { type: 'deposit', amount: 100, units_delta: 100, created_at: 1000 },
    ]);
    const snapshots = [
        { snapshotAt: 1000, navPerUnit: 1.0 },
        { snapshotAt: 2000, navPerUnit: 1.1 },
        { snapshotAt: 3000, navPerUnit: 1.2 },
    ];
    const history = buildInvestorPerformanceHistory(tx, snapshots, 3000, 120);
    assert.equal(history.length, 3);
    assert.equal(history[0].value, 100);
    assert.equal(history[2].value, 120);
    const periodReturn = calculatePeriodReturn(history, 1500, 3000);
    assert.equal(Math.round(periodReturn * 100) / 100, 9.09);
});

test('return helpers are deterministic and non-divergent', () => {
    assert.equal(computeReturnPct(120, 100), 20);
    assert.equal(computeReturnPct(0, 0), 0);
    assert.equal(computeFundReturnPct(1100, 1000), 10);
    assert.equal(computeFundReturnPct(0, 0), 0);
});

test('trade lifecycle summary explains fills vs closed outcomes', () => {
    const summary = summarizeTradeLifecycle({
        wins: 65,
        losses: 6,
        breakevens: 3,
        fills: 152,
    });
    assert.equal(summary.closedTrades, 74);
    assert.equal(summary.resolvedTrades, 71);
    assert.equal(summary.nonClosingFills, 78);
    assert.equal(summary.winRate, 91.55);
});

test('computeReconciliation flags balanced and unbalanced ledgers', () => {
    const balanced = computeReconciliation({
        nav: 1000,
        capital: 900,
        pnl: 100,
        fees: 0,
        investorValue: 1000,
        unitsValue: 1000,
        tolerance: 0.01,
    });
    assert.equal(balanced.isNavBalanced, true);
    assert.equal(balanced.isInvestorLedgerBalanced, true);
    assert.equal(balanced.isUnitsBalanced, true);

    const broken = computeReconciliation({
        nav: 1000,
        capital: 900,
        pnl: 80,
        fees: 0,
        investorValue: 950,
        unitsValue: 920,
        tolerance: 0.01,
    });
    assert.equal(broken.isNavBalanced, false);
    assert.equal(broken.isInvestorLedgerBalanced, false);
    assert.equal(broken.isUnitsBalanced, false);
});

test('latestNavPerUnitAt returns fallback when no snapshots match', () => {
    assert.equal(latestNavPerUnitAt([], Date.now(), 1), 1);
    const snapshots = [{ snapshotAt: 5000, navPerUnit: 1.25 }];
    assert.equal(latestNavPerUnitAt(snapshots, 4000, 1), 1);
    assert.equal(latestNavPerUnitAt(snapshots, 6000, 1), 1.25);
});
