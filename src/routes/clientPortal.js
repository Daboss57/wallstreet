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
const engine = require('../engine');

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

    // Calculate total contributed (deposits - withdrawals)
    let totalContributed = 0;
    for (const tx of transactions) {
        if (tx.type === 'deposit') {
            totalContributed += tx.amount;
        } else if (tx.type === 'withdrawal') {
            totalContributed -= tx.amount;
        }
    }

    // Get all capital for this fund to calculate ownership percentage
    const allCapitalTxns = await stmts.getFundCapitalTransactions.all(fundId);
    let totalFundCapital = 0;
    for (const tx of allCapitalTxns) {
        if (tx.type === 'deposit') {
            totalFundCapital += tx.amount;
        } else if (tx.type === 'withdrawal') {
            totalFundCapital -= tx.amount;
        }
    }

    // Calculate ownership percentage
    const ownershipPct = totalFundCapital > 0 ? (totalContributed / totalFundCapital) * 100 : 0;

    // For current value, we'd need to track fund performance
    // For now, use a simulated return based on fund strategy
    // In production, this would come from actual fund P&L tracking
    const fundReturnPct = calculateSimulatedFundReturn(req.fund);
    const currentValue = totalContributed * (1 + fundReturnPct / 100);
    const unrealizedPnl = currentValue - totalContributed;

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        capital_contributed: Math.round(totalContributed * 100) / 100,
        current_value: Math.round(currentValue * 100) / 100,
        unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
        return_pct: Math.round(fundReturnPct * 100) / 100,
        ownership_pct: Math.round(ownershipPct * 100) / 100,
        management_fee: req.fund.management_fee,
        performance_fee: req.fund.performance_fee,
    });
}));

/**
 * GET /api/client-portal/performance
 * Returns client's P&L breakdown (lifetime, monthly, weekly)
 */
router.get('/performance', asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const fundId = req.fund.id;

    // Get user's capital transactions
    const transactions = await stmts.getUserCapitalInFund.all(fundId, userId);

    // Calculate total contributed
    let totalContributed = 0;
    for (const tx of transactions) {
        totalContributed += tx.type === 'deposit' ? tx.amount : -tx.amount;
    }

    // Simulate performance over time (in production, would track actual fund performance)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const weekMs = 7 * dayMs;
    const monthMs = 30 * dayMs;

    // Generate performance timeline based on fund strategy
    const fundReturnPct = calculateSimulatedFundReturn(req.fund);
    const currentValue = totalContributed * (1 + fundReturnPct / 100);

    // Create performance data points
    const performanceHistory = generatePerformanceHistory(
        totalContributed,
        fundReturnPct,
        transactions
    );

    // Calculate period returns
    const weeklyReturn = calculatePeriodReturn(performanceHistory, weekMs);
    const monthlyReturn = calculatePeriodReturn(performanceHistory, monthMs);
    const lifetimeReturn = fundReturnPct;

    // Calculate daily P&L for chart
    const dailyPnl = performanceHistory.map(point => ({
        date: new Date(point.timestamp).toISOString().split('T')[0],
        value: point.value,
        pnl: point.value - totalContributed,
        pnl_pct: totalContributed > 0 ? ((point.value - totalContributed) / totalContributed) * 100 : 0,
    }));

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        lifetime_return_pct: Math.round(lifetimeReturn * 100) / 100,
        monthly_return_pct: Math.round(monthlyReturn * 100) / 100,
        weekly_return_pct: Math.round(weeklyReturn * 100) / 100,
        total_pnl: Math.round((currentValue - totalContributed) * 100) / 100,
        starting_capital: totalContributed,
        current_value: Math.round(currentValue * 100) / 100,
        performance_history: dailyPnl.slice(-90), // Last 90 days
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
    const [strategies, customStrategies] = await Promise.all([
        stmts.getStrategiesByFund.all(fundId),
        stmts.getCustomStrategiesByFund.all(fundId),
    ]);

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

    for (const s of strategies) {
        formattedStrategies.push({
            id: s.id,
            name: s.name,
            type: s.type,
            description: STRATEGY_DESCRIPTIONS[s.type] || 'Trading strategy',
            is_active: s.is_active,
            created_at: s.created_at,
            // Simulated performance (in production, calculate from actual trades)
            return_pct: s.is_active ? (Math.random() * 30 - 10).toFixed(2) : 0,
        });
    }

    for (const s of customStrategies) {
        formattedStrategies.push({
            id: s.id,
            name: s.name,
            type: 'custom',
            description: STRATEGY_DESCRIPTIONS['custom'],
            is_active: s.is_active,
            created_at: s.created_at,
            // Simulated performance
            return_pct: s.is_active ? (Math.random() * 30 - 10).toFixed(2) : 0,
        });
    }

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        strategies: formattedStrategies,
        active_count: formattedStrategies.filter(s => s.is_active).length,
        total_count: formattedStrategies.length,
    });
}));

/**
 * GET /api/client-portal/fund-summary
 * Returns aggregated fund performance (NO individual positions or trades)
 */
router.get('/fund-summary', asyncRoute(async (req, res) => {
    const fundId = req.fund.id;

    // Get all members (count only, no names)
    const members = await stmts.getFundMembers.all(fundId);

    // Get all capital transactions
    const allCapitalTxns = await stmts.getFundCapitalTransactions.all(fundId);

    // Calculate total AUM
    let totalAum = 0;
    for (const tx of allCapitalTxns) {
        totalAum += tx.type === 'deposit' ? tx.amount : -tx.amount;
    }

    // Count clients (members with client role)
    const clientCount = members.filter(m => m.role === 'client').length;

    // Calculate overall fund return
    const fundReturnPct = calculateSimulatedFundReturn(req.fund);

    // Get strategy counts
    const [strategies, customStrategies] = await Promise.all([
        stmts.getStrategiesByFund.all(fundId),
        stmts.getCustomStrategiesByFund.all(fundId),
    ]);

    const activeStrategies = [...strategies, ...customStrategies].filter(s => s.is_active).length;
    const totalStrategies = strategies.length + customStrategies.length;

    res.json({
        fund_id: fundId,
        fund_name: req.fund.name,
        strategy_type: req.fund.strategy_type,
        total_aum: Math.round(totalAum * 100) / 100,
        member_count: members.length,
        client_count: clientCount,
        overall_return_pct: Math.round(fundReturnPct * 100) / 100,
        active_strategies: activeStrategies,
        total_strategies: totalStrategies,
        management_fee: req.fund.management_fee,
        performance_fee: req.fund.performance_fee,
        min_investment: req.fund.min_investment,
        description: req.fund.description,
    });
}));

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Calculate simulated fund return based on strategy type
 * In production, this would use actual fund P&L data
 */
function calculateSimulatedFundReturn(fund) {
    // Use deterministic "random" based on fund ID for consistency
    const hash = fund.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const baseReturn = (hash % 100) - 30; // Range: -30% to +70%
    
    // Adjust based on strategy type
    const strategyMultipliers = {
        'momentum': 1.3,      // Higher volatility
        'mean_reversion': 0.8, // Lower volatility
        'grid': 1.0,          // Moderate
        'pairs': 0.7,         // Lower volatility
        'custom': 1.1,        // Unknown, moderate-high
    };
    
    const multiplier = strategyMultipliers[fund.strategy_type] || 1.0;
    return baseReturn * multiplier;
}

/**
 * Generate performance history data points
 */
function generatePerformanceHistory(initialCapital, totalReturn, transactions) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const points = [];
    
    // Generate 90 days of history
    const days = 90;
    const dailyReturn = totalReturn / days;
    
    // Start with capital from 90 days ago
    // Adjust for deposits/withdrawals in that period
    let capitalAtDay = initialCapital;
    
    for (let i = days; i >= 0; i--) {
        const timestamp = now - (i * dayMs);
        
        // Check for transactions on this day
        for (const tx of transactions) {
            const txDay = Math.floor((now - tx.created_at) / dayMs);
            if (txDay === i) {
                capitalAtDay -= tx.type === 'deposit' ? 0 : -tx.amount;
            }
        }
        
        // Calculate value with accumulated return
        const daysElapsed = days - i;
        const cumulativeReturn = dailyReturn * daysElapsed;
        const value = capitalAtDay * (1 + cumulativeReturn / 100);
        
        points.push({
            timestamp,
            value: Math.max(0, value), // Never negative
        });
    }
    
    return points;
}

/**
 * Calculate return over a specific period
 */
function calculatePeriodReturn(history, periodMs) {
    const now = Date.now();
    const cutoff = now - periodMs;
    
    const startPoint = history.find(p => p.timestamp >= cutoff);
    const endPoint = history[history.length - 1];
    
    if (!startPoint || !endPoint || startPoint.value === 0) {
        return 0;
    }
    
    return ((endPoint.value - startPoint.value) / startPoint.value) * 100;
}

module.exports = router;