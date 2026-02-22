/**
 * StreetOS Client Portal Routes
 * Restricted dashboard for fund investors with "client" role
 * 
 * Security: All endpoints verify "client" role and only return user-specific data
 * Never exposes: strategy code, live positions, order book, other members' data
 */

const express = require('express');
const router = express.Router();
const { stmts, isDbUnavailableError } = require('../db');
const { authenticate } = require('../auth');
const strategyRunner = require('../strategyRunner');
const {
    round2,
    round4,
    round8,
    normalizeCapitalTransactions,
    normalizeNavSnapshots,
    sumNetCapital,
    sumUnits,
    cumulativeUnitsAt,
    latestNavPerUnitAt,
    computeReturnPct,
    computeFundReturnPct,
    buildInvestorPerformanceHistory,
    calculatePeriodReturn,
    getUtcMonthStart,
    shiftUtcMonth,
    getUtcMonthEnd,
    formatMonthKey,
    formatMonthLabel,
    parseMonthKeyToUtcMonthStart,
} = require('../metrics/fundMetrics');

// Helper to handle DB unavailability
function handleRouteError(res, error, defaultStatus = 500) {
    if (isDbUnavailableError(error)) {
        return res.status(503).json({ error: 'db_unavailable' });
    }
    return res.status(defaultStatus).json({ error: error.message || 'Internal server error' });
}

function asyncRoute(handler, defaultStatus = 500) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            handleRouteError(res, error, defaultStatus);
        }
    };
}

/**
 * Middleware: Verify user is a client member of a fund
 * Attaches fund and membership to request
 */
async function requireClientRole(req, res, next) {
    try {
        const userId = req.user.id;
        const fundId = req.query.fund_id;

        if (!fundId) {
            return res.status(400).json({ error: 'fund_id query parameter required' });
        }

        // Get user's membership in this fund
        const membership = await stmts.getFundMember.get(fundId, userId);
        
        if (!membership) {
            return res.status(403).json({ error: 'Not a member of this fund' });
        }

        // Verify client role (or allow owners/analysts to view as well for testing)
        const validRoles = ['client', 'analyst', 'owner'];
        if (!validRoles.includes(membership.role)) {
            return res.status(403).json({ error: 'Client access required' });
        }

        // Get fund details
        const fund = await stmts.getFundById.get(fundId);
        if (!fund) {
            return res.status(404).json({ error: 'Fund not found' });
        }

        req.fund = fund;
        req.membership = membership;
        next();
    } catch (error) {
        handleRouteError(res, error);
    }
}

// Apply authentication to all client portal routes
router.use(authenticate);
router.use(requireClientRole);

/**
 * GET /api/client-portal/allocation
 * Returns the client's capital allocation and current value
 */
router.get('/allocation', asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const fundId = req.fund.id;

    // Get user's capital transactions in this fund
    const transactions = await stmts.getUserCapitalInFund.all(fundId, userId);

    const normalizedTransactions = normalizeCapitalTransactions(transactions);
    const userUnits = sumUnits(normalizedTransactions);
    const totalContributed = sumNetCapital(normalizedTransactions);

    const [allCapitalTxns, snapshotsRaw, netCapitalRow] = await Promise.all([
        stmts.getFundCapitalTransactions.all(fundId),
        stmts.getFundNavSnapshots.all(fundId, 1),
        stmts.getFundNetCapital.get(fundId),
    ]);
    const normalizedAllTx = normalizeCapitalTransactions(allCapitalTxns);
    const totalUnits = sumUnits(normalizedAllTx);
    const snapshots = normalizeNavSnapshots(snapshotsRaw);
    const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const navPerUnit = latestNavPerUnitAt(snapshots, Date.now(), 1);
    const currentValue = userUnits * navPerUnit;
    const unrealizedPnl = currentValue - totalContributed;
    const returnPct = computeReturnPct(currentValue, totalContributed);
    const ownershipPct = totalUnits > 0 ? (userUnits / totalUnits) * 100 : 0;
    const fundCapital = Number(netCapitalRow?.net_capital || 0);
    const fundCurrentValue = totalUnits * navPerUnit;
    const fundReturnPct = computeFundReturnPct(fundCurrentValue, fundCapital);
    const asOf = Number(latestSnapshot?.snapshotAt || Date.now());

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        as_of: asOf,
        capital_contributed: round2(totalContributed),
        current_value: round2(currentValue),
        unrealized_pnl: round2(unrealizedPnl),
        return_pct: round2(returnPct),
        ownership_pct: round2(ownershipPct),
        fund_return_pct: round2(fundReturnPct),
        management_fee: req.fund.management_fee,
        performance_fee: req.fund.performance_fee,
        calculation_basis: {
            value: 'units_x_latest_nav_per_unit',
            ownership: 'investor_units_over_total_units',
            return_pct: 'unrealized_pnl_over_net_contributed',
        },
    });
}));

/**
 * GET /api/client-portal/performance
 * Returns client's P&L breakdown (lifetime, monthly, weekly)
 */
router.get('/performance', asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const fundId = req.fund.id;

    const [transactionsRaw, snapshotsRaw] = await Promise.all([
        stmts.getUserCapitalInFund.all(fundId, userId),
        stmts.getFundNavSnapshots.all(fundId, 2000),
    ]);

    const transactions = normalizeCapitalTransactions(transactionsRaw);
    const snapshots = normalizeNavSnapshots(snapshotsRaw);

    const totalContributed = sumNetCapital(transactions);
    const currentUnits = cumulativeUnitsAt(transactions, Date.now());
    const currentNavPerUnit = latestNavPerUnitAt(snapshots, Date.now());
    const currentValue = currentUnits * currentNavPerUnit;

    const performanceHistory = buildInvestorPerformanceHistory(transactions, snapshots, Date.now(), currentValue);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;
    const monthMs = 30 * dayMs;

    const weeklyReturn = calculatePeriodReturn(performanceHistory, weekMs, now);
    const monthlyReturn = calculatePeriodReturn(performanceHistory, monthMs, now);
    const lifetimeReturn = computeReturnPct(currentValue, totalContributed);

    const dailyPnl = performanceHistory.map(point => ({
        date: new Date(point.timestamp).toISOString().split('T')[0],
        value: round2(point.value),
        pnl: round2(point.value - totalContributed),
        pnl_pct: totalContributed > 0 ? round4(((point.value - totalContributed) / totalContributed) * 100) : 0,
    }));

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        as_of: performanceHistory.length ? performanceHistory[performanceHistory.length - 1].timestamp : now,
        lifetime_return_pct: round2(lifetimeReturn),
        monthly_return_pct: round2(monthlyReturn),
        weekly_return_pct: round2(weeklyReturn),
        total_pnl: round2(currentValue - totalContributed),
        starting_capital: round2(totalContributed),
        current_value: round2(currentValue),
        performance_history: dailyPnl.slice(-90), // Last 90 days
        calculation_basis: {
            value_history: 'investor_units_at_snapshot_x_snapshot_nav_per_unit',
            period_returns: 'point_to_point_change_from_history',
        },
    });
}));

/**
 * GET /api/client-portal/transactions
 * Returns client's deposit/withdrawal history
 */
router.get('/transactions', asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const fundId = req.fund.id;

    const transactions = await stmts.getUserCapitalInFund.all(fundId, userId);

    // Format transactions for display
    const formatted = transactions.map(tx => ({
        id: tx.id,
        date: new Date(tx.created_at).toISOString().split('T')[0],
        type: tx.type.charAt(0).toUpperCase() + tx.type.slice(1), // Capitalize
        amount: tx.amount,
        status: 'Completed', // All recorded transactions are completed
        created_at: tx.created_at,
    }));

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        as_of: Date.now(),
        transactions: formatted,
    });
}));

/**
 * GET /api/client-portal/strategies
 * Returns strategy names and descriptions only
 * NO code, NO parameters, NO positions
 */
router.get('/strategies', asyncRoute(async (req, res) => {
    const fundId = req.fund.id;

    // Get all strategies for this fund
    const [strategies, customStrategies, netCapitalRow] = await Promise.all([
        stmts.getStrategiesByFund.all(fundId),
        stmts.getCustomStrategiesByFund.all(fundId),
        stmts.getFundNetCapital.get(fundId),
    ]);
    const fundCapital = Number(netCapitalRow?.net_capital || 0);
    const dashboard = strategyRunner.getDashboardData(fundId, strategies || []);
    const dashboardById = new Map((dashboard?.strategies || []).map((s) => [s.id, s]));

    // Strategy type descriptions (safe for client view)
    const STRATEGY_DESCRIPTIONS = {
        'mean_reversion': 'Identifies overbought and oversold conditions, buying low and selling high.',
        'momentum': 'Follows market trends, entering positions that show strong directional movement.',
        'grid': 'Places buy and sell orders at fixed intervals around a price level.',
        'pairs': 'Trades correlated assets, profiting from divergence in their price relationship.',
        'custom': 'Custom trading algorithm designed for this fund.',
    };

    // Format strategies - ONLY safe info, no code/config
    const formattedStrategies = [];
    const seen = new Set();

    for (const s of strategies) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const d = dashboardById.get(s.id) || {};
        const strategyPnl = Number(d.realizedPnl || 0) + Number(d.unrealizedPnl || 0);
        const returnPct = fundCapital > 0 ? (strategyPnl / fundCapital) * 100 : 0;
        formattedStrategies.push({
            id: s.id,
            name: s.name,
            type: s.type,
            description: STRATEGY_DESCRIPTIONS[s.type] || 'Trading strategy',
            is_active: s.is_active,
            created_at: s.created_at,
            trade_count: Number(d.fillCount || d.tradeCount || 0),
            return_pct: round2(returnPct),
        });
    }

    for (const s of customStrategies) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const d = dashboardById.get(s.id) || {};
        const strategyPnl = Number(d.realizedPnl || 0) + Number(d.unrealizedPnl || 0);
        const returnPct = fundCapital > 0 ? (strategyPnl / fundCapital) * 100 : 0;
        formattedStrategies.push({
            id: s.id,
            name: s.name,
            type: 'custom',
            description: STRATEGY_DESCRIPTIONS['custom'],
            is_active: s.is_active,
            created_at: s.created_at,
            trade_count: Number(d.fillCount || d.tradeCount || 0),
            return_pct: round2(returnPct),
        });
    }

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        as_of: Date.now(),
        strategies: formattedStrategies,
        active_count: formattedStrategies.filter(s => s.is_active).length,
        total_count: formattedStrategies.length,
        calculation_basis: {
            return_pct: 'strategy_total_pnl_over_fund_net_capital',
        },
    });
}));

/**
 * GET /api/client-portal/fund-summary
 * Returns aggregated fund performance (NO individual positions or trades)
 */
router.get('/fund-summary', asyncRoute(async (req, res) => {
    const fundId = req.fund.id;

    // Get all members (count only, no names)
    const [members, allCapitalTxns, strategies, customStrategies, snapshotsRaw, netCapitalRow, fundStrategyTrades] = await Promise.all([
        stmts.getFundMembers.all(fundId),
        stmts.getFundCapitalTransactions.all(fundId),
        stmts.getStrategiesByFund.all(fundId),
        stmts.getCustomStrategiesByFund.all(fundId),
        stmts.getFundNavSnapshots.all(fundId, 1),
        stmts.getFundNetCapital.get(fundId),
        stmts.getFundStrategyTrades.all(fundId, 5000),
    ]);

    const normalizedFundTx = normalizeCapitalTransactions(allCapitalTxns);
    const totalCapital = sumNetCapital(normalizedFundTx);
    const snapshots = normalizeNavSnapshots(snapshotsRaw);
    const latestSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : null;
    const snapshotNav = Number(latestSnapshot?.nav || 0);
    const snapshotCapital = Number(latestSnapshot?.capital || totalCapital);
    const navPerUnit = Number(latestSnapshot?.navPerUnit || 1);
    const totalAum = snapshotNav > 0 ? snapshotNav : totalCapital;

    // Count clients (members with client role)
    const clientCount = members.filter(m => m.role === 'client').length;
    const netCapital = Number(netCapitalRow?.net_capital ?? snapshotCapital ?? totalCapital ?? 0);
    const fundReturnPct = netCapital > 0 ? ((totalAum - netCapital) / netCapital) * 100 : 0;

    const activeStrategies = [...strategies, ...customStrategies].filter(s => s.is_active).length;
    const totalStrategies = strategies.length + customStrategies.length;
    const monthlyCostMap = new Map();
    for (const trade of fundStrategyTrades || []) {
        const executedAt = Number(trade.executed_at || 0);
        if (!Number.isFinite(executedAt) || executedAt <= 0) continue;
        const monthStart = getUtcMonthStart(executedAt);
        const monthKey = formatMonthKey(monthStart);
        if (!monthlyCostMap.has(monthKey)) {
            monthlyCostMap.set(monthKey, {
                month_key: monthKey,
                month_label: formatMonthLabel(monthStart),
                slippage_cost: 0,
                commission_cost: 0,
                borrow_cost: 0,
                total_cost: 0,
            });
        }
        const row = monthlyCostMap.get(monthKey);
        row.slippage_cost += Number(trade.slippage_cost || 0);
        row.commission_cost += Number(trade.commission || 0);
        row.borrow_cost += Number(trade.borrow_cost || 0);
        row.total_cost = row.slippage_cost + row.commission_cost + row.borrow_cost;
    }
    const monthlyExecutionCosts = Array.from(monthlyCostMap.values())
        .sort((a, b) => (a.month_key < b.month_key ? 1 : -1))
        .slice(0, 12)
        .map((row) => ({
            ...row,
            slippage_cost: round2(row.slippage_cost),
            commission_cost: round2(row.commission_cost),
            borrow_cost: round2(row.borrow_cost),
            total_cost: round2(row.total_cost),
        }));
    const totalExecutionCost = monthlyExecutionCosts.reduce((sum, row) => sum + Number(row.total_cost || 0), 0);

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        as_of: Number(latestSnapshot?.snapshotAt || Date.now()),
        strategy_type: req.fund.strategy_type,
        total_aum: round2(totalAum),
        total_capital: round2(netCapital),
        nav_per_unit: round8(navPerUnit),
        nav_as_of: Number(latestSnapshot?.snapshotAt || Date.now()),
        member_count: members.length,
        client_count: clientCount,
        overall_return_pct: round2(fundReturnPct),
        active_strategies: activeStrategies,
        total_strategies: totalStrategies,
        execution_cost_summary: {
            trailing_months: monthlyExecutionCosts.length,
            total_execution_cost: round2(totalExecutionCost),
            monthly: monthlyExecutionCosts,
        },
        management_fee: req.fund.management_fee,
        performance_fee: req.fund.performance_fee,
        min_investment: req.fund.min_investment,
        description: req.fund.description,
        calculation_basis: {
            total_aum: 'latest_nav_snapshot_or_net_capital_fallback',
            overall_return_pct: 'aum_minus_net_capital_over_net_capital',
        },
    });
}));

/**
 * GET /api/client-portal/statements
 * Returns monthly investor statements based on unit + NAV history.
 */
router.get('/statements', asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const fundId = req.fund.id;
    const now = Date.now();
    const maxMonths = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);

    const [transactionsRaw, snapshotsRaw] = await Promise.all([
        stmts.getUserCapitalInFund.all(fundId, userId),
        stmts.getFundNavSnapshots.all(fundId, 2000),
    ]);

    const transactions = normalizeCapitalTransactions(transactionsRaw);
    const snapshots = normalizeNavSnapshots(snapshotsRaw);

    if (transactions.length === 0 && snapshots.length === 0) {
        return res.json({
            fund_id: fundId,
            fund_name: req.fund.name,
            as_of: now,
            statements: [],
            summary: {
                net_contributed: 0,
                current_value: 0,
                since_inception_pnl: 0,
                since_inception_return_pct: 0,
                total_estimated_fees: 0,
            },
        });
    }

    const firstDataTs = Math.min(
        transactions.length ? transactions[0].createdAt : now,
        snapshots.length ? snapshots[0].snapshotAt : now
    );

    const currentMonthStart = getUtcMonthStart(now);
    const minMonthStart = getUtcMonthStart(firstDataTs);
    const monthStarts = [];
    for (let monthStart = currentMonthStart; monthStart >= minMonthStart; monthStart = shiftUtcMonth(monthStart, -1)) {
        monthStarts.push(monthStart);
    }
    monthStarts.reverse();

    const managementFeeAnnual = Number(req.fund.management_fee || 0);
    const performanceFeeRate = Number(req.fund.performance_fee || 0);

    const statements = [];
    for (const monthStart of monthStarts) {
        const monthEnd = getUtcMonthEnd(monthStart);
        const openingTs = monthStart - 1;

        const openingUnits = cumulativeUnitsAt(transactions, openingTs);
        const closingUnits = cumulativeUnitsAt(transactions, monthEnd);

        const openingNavPerUnit = latestNavPerUnitAt(snapshots, openingTs);
        const closingNavPerUnit = latestNavPerUnitAt(snapshots, monthEnd);

        const openingValue = openingUnits * openingNavPerUnit;
        const closingValue = closingUnits * closingNavPerUnit;

        let subscriptions = 0;
        let redemptions = 0;
        let unitsSubscribed = 0;
        let unitsRedeemed = 0;
        for (const tx of transactions) {
            if (tx.createdAt < monthStart || tx.createdAt > monthEnd) continue;
            if (tx.type === 'deposit') {
                subscriptions += tx.amount;
                unitsSubscribed += tx.unitsDelta;
            } else {
                redemptions += tx.amount;
                unitsRedeemed += Math.abs(tx.unitsDelta);
            }
        }

        const netFlows = subscriptions - redemptions;
        const grossPnl = closingValue - openingValue - netFlows;
        const avgCapital = openingValue + (netFlows / 2);
        const estimatedMgmtFee = avgCapital > 0 ? (avgCapital * managementFeeAnnual) / 12 : 0;
        const estimatedPerfFee = grossPnl > 0 ? grossPnl * performanceFeeRate : 0;
        const estimatedFees = estimatedMgmtFee + estimatedPerfFee;
        const netPnlAfterFees = grossPnl - estimatedFees;
        const netReturnPct = avgCapital !== 0 ? (netPnlAfterFees / avgCapital) * 100 : 0;

        const hasActivity = (
            Math.abs(openingUnits) > 1e-9
            || Math.abs(closingUnits) > 1e-9
            || Math.abs(subscriptions) > 1e-9
            || Math.abs(redemptions) > 1e-9
        );
        if (!hasActivity) continue;

        statements.push({
            month_key: formatMonthKey(monthStart),
            month_label: formatMonthLabel(monthStart),
            opening_units: round8(openingUnits),
            opening_nav_per_unit: round8(openingNavPerUnit),
            opening_value: round2(openingValue),
            subscriptions: round2(subscriptions),
            redemptions: round2(redemptions),
            net_flows: round2(netFlows),
            units_subscribed: round8(unitsSubscribed),
            units_redeemed: round8(unitsRedeemed),
            closing_units: round8(closingUnits),
            closing_nav_per_unit: round8(closingNavPerUnit),
            closing_value: round2(closingValue),
            gross_pnl: round2(grossPnl),
            estimated_management_fee: round2(estimatedMgmtFee),
            estimated_performance_fee: round2(estimatedPerfFee),
            estimated_total_fees: round2(estimatedFees),
            net_pnl_after_fees: round2(netPnlAfterFees),
            net_return_pct: round4(netReturnPct),
        });
    }

    const latestStatement = statements[statements.length - 1];
    const netContributed = round2(
        transactions.reduce((sum, tx) => sum + (tx.type === 'deposit' ? tx.amount : -tx.amount), 0)
    );
    const currentUnits = cumulativeUnitsAt(transactions, now);
    const currentNavPerUnit = latestNavPerUnitAt(snapshots, now);
    const currentValue = round2(currentUnits * currentNavPerUnit);
    const sinceInceptionPnl = round2(currentValue - netContributed);
    const totalEstimatedFees = round2(
        statements.reduce((sum, row) => sum + row.estimated_total_fees, 0)
    );
    const sinceInceptionReturnPct = netContributed !== 0
        ? round4((sinceInceptionPnl / netContributed) * 100)
        : 0;

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        as_of: latestStatement ? getUtcMonthEnd(parseMonthKeyToUtcMonthStart(latestStatement.month_key)) : now,
        statements: statements.slice(-maxMonths).reverse(),
        summary: {
            net_contributed: netContributed,
            current_value: currentValue,
            since_inception_pnl: sinceInceptionPnl,
            since_inception_return_pct: sinceInceptionReturnPct,
            total_estimated_fees: totalEstimatedFees,
        },
        assumptions: {
            management_fee_annual_rate: managementFeeAnnual,
            performance_fee_rate: performanceFeeRate,
            notes: [
                'Management fee is estimated monthly using average capital for the month.',
                'Performance fee is estimated on positive monthly gross P&L.',
            ],
        },
        calculation_basis: {
            value: 'units_x_month_end_nav_per_unit',
            gross_pnl: 'ending_minus_opening_minus_net_flows',
            fees: 'estimated_management_plus_estimated_performance',
        },
    });
}));

// ============================================================
// HELPER FUNCTIONS
// ============================================================

module.exports = router;
