function toNum(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 2) {
    const factor = 10 ** decimals;
    return Math.round((toNum(value, 0) + Number.EPSILON) * factor) / factor;
}

function round2(value) {
    return round(value, 2);
}

function round4(value) {
    return round(value, 4);
}

function round8(value) {
    return round(value, 8);
}

function inferUnitsDelta(type, amount) {
    if (type === 'deposit') return amount;
    if (type === 'withdrawal') return -amount;
    return 0;
}

function inferUnitsFromNav(type, amount, navPerUnit) {
    const nav = toNum(navPerUnit, 0);
    if (nav <= 0) return null;
    const signedAmount = inferUnitsDelta(type, amount);
    return signedAmount / nav;
}

function normalizeCapitalTransactions(rows) {
    return (rows || [])
        .map((tx) => {
            const amount = toNum(tx.amount, 0);
            const createdAt = toNum(tx.created_at ?? tx.createdAt, 0);
            const type = tx.type;
            const navPerUnit = toNum(tx.nav_per_unit ?? tx.navPerUnit, 0);
            const unitsDeltaRaw = Number(tx.units_delta ?? tx.unitsDelta);
            const impliedUnits = inferUnitsFromNav(type, amount, navPerUnit);

            let unitsDelta = inferUnitsDelta(type, amount);
            if (Number.isFinite(unitsDeltaRaw)) {
                unitsDelta = unitsDeltaRaw;
            }
            if (Number.isFinite(impliedUnits) && (
                !Number.isFinite(unitsDeltaRaw) || Math.abs(unitsDeltaRaw - impliedUnits) > 1e-6
            )) {
                unitsDelta = impliedUnits;
            }

            return {
                id: tx.id,
                userId: tx.user_id ?? tx.userId ?? null,
                username: tx.username ?? null,
                type,
                amount,
                unitsDelta,
                createdAt,
                navPerUnit,
            };
        })
        .filter((tx) => tx.createdAt > 0 && (tx.type === 'deposit' || tx.type === 'withdrawal'))
        .sort((a, b) => a.createdAt - b.createdAt);
}

function normalizeNavSnapshots(rows) {
    return (rows || [])
        .map((row) => ({
            snapshotAt: toNum(row.snapshot_at ?? row.snapshotAt, 0),
            navPerUnit: toNum(row.nav_per_unit ?? row.navPerUnit, 1),
            nav: toNum(row.nav, 0),
            capital: toNum(row.capital, 0),
            pnl: toNum(row.pnl, 0),
            totalUnits: toNum(row.total_units ?? row.totalUnits, 0),
        }))
        .filter((snapshot) => snapshot.snapshotAt > 0)
        .sort((a, b) => a.snapshotAt - b.snapshotAt);
}

function sumNetCapital(transactions) {
    let total = 0;
    for (const tx of transactions || []) {
        total += tx.type === 'deposit' ? toNum(tx.amount, 0) : -toNum(tx.amount, 0);
    }
    return total;
}

function sumUnits(transactions) {
    let total = 0;
    for (const tx of transactions || []) {
        total += toNum(tx.unitsDelta, 0);
    }
    return total;
}

function cumulativeUnitsAt(transactions, timestamp) {
    const cutoff = toNum(timestamp, 0);
    let total = 0;
    for (const tx of transactions || []) {
        if (toNum(tx.createdAt, 0) <= cutoff) {
            total += toNum(tx.unitsDelta, 0);
        }
    }
    return total;
}

function latestNavPerUnitAt(snapshots, timestamp, fallback = 1) {
    const cutoff = toNum(timestamp, 0);
    let navPerUnit = toNum(fallback, 1);
    for (const snapshot of snapshots || []) {
        if (toNum(snapshot.snapshotAt, 0) <= cutoff) navPerUnit = toNum(snapshot.navPerUnit, navPerUnit);
        else break;
    }
    return navPerUnit;
}

function computeReturnPct(currentValue, costBasis) {
    const value = toNum(currentValue, 0);
    const basis = toNum(costBasis, 0);
    if (basis === 0) return 0;
    return ((value - basis) / basis) * 100;
}

function computeFundReturnPct(nav, capital) {
    const navValue = toNum(nav, 0);
    const capitalValue = toNum(capital, 0);
    if (capitalValue <= 0) return 0;
    return ((navValue - capitalValue) / capitalValue) * 100;
}

function summarizeTradeLifecycle({ wins = 0, losses = 0, breakevens = 0, fills = 0 }) {
    const safeWins = Math.max(0, Math.floor(toNum(wins, 0)));
    const safeLosses = Math.max(0, Math.floor(toNum(losses, 0)));
    const safeBreakevens = Math.max(0, Math.floor(toNum(breakevens, 0)));
    const safeFills = Math.max(0, Math.floor(toNum(fills, 0)));
    const closedTrades = safeWins + safeLosses + safeBreakevens;
    const resolvedTrades = safeWins + safeLosses;
    const winRate = resolvedTrades > 0 ? (safeWins / resolvedTrades) * 100 : 0;
    const nonClosingFills = Math.max(0, safeFills - closedTrades);
    return {
        wins: safeWins,
        losses: safeLosses,
        breakevens: safeBreakevens,
        fills: safeFills,
        closedTrades,
        resolvedTrades,
        nonClosingFills,
        winRate: round2(winRate),
    };
}

function buildInvestorPerformanceHistory(transactions, snapshots, now = Date.now(), fallbackCurrentValue = 0) {
    const normalizedSnapshots = snapshots || [];
    if (!normalizedSnapshots.length) {
        return [{
            timestamp: toNum(now, Date.now()),
            value: toNum(fallbackCurrentValue, 0),
        }];
    }

    const points = normalizedSnapshots.map((snapshot) => {
        const units = cumulativeUnitsAt(transactions, snapshot.snapshotAt);
        return {
            timestamp: snapshot.snapshotAt,
            value: units * toNum(snapshot.navPerUnit, 1),
        };
    });

    const last = points[points.length - 1];
    const currentTs = toNum(now, Date.now());
    if (!last || currentTs - toNum(last.timestamp, 0) > 60_000) {
        points.push({
            timestamp: currentTs,
            value: toNum(fallbackCurrentValue, last ? last.value : 0),
        });
    }
    return points;
}

function calculatePeriodReturn(history, periodMs, now = Date.now()) {
    const cutoff = toNum(now, Date.now()) - toNum(periodMs, 0);
    const startPoint = (history || []).find((point) => toNum(point.timestamp, 0) >= cutoff);
    const endPoint = history && history.length ? history[history.length - 1] : null;
    if (!startPoint || !endPoint || toNum(startPoint.value, 0) === 0) return 0;
    return ((toNum(endPoint.value, 0) - toNum(startPoint.value, 0)) / toNum(startPoint.value, 1)) * 100;
}

function getUtcMonthStart(timestamp) {
    const d = new Date(toNum(timestamp, Date.now()));
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

function shiftUtcMonth(monthStartTimestamp, deltaMonths) {
    const d = new Date(toNum(monthStartTimestamp, Date.now()));
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + toNum(deltaMonths, 0), 1, 0, 0, 0, 0);
}

function getUtcMonthEnd(monthStartTimestamp) {
    return shiftUtcMonth(monthStartTimestamp, 1) - 1;
}

function formatMonthKey(monthStartTimestamp) {
    const d = new Date(toNum(monthStartTimestamp, Date.now()));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function formatMonthLabel(monthStartTimestamp) {
    const d = new Date(toNum(monthStartTimestamp, Date.now()));
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function parseMonthKeyToUtcMonthStart(monthKey) {
    if (typeof monthKey !== 'string' || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return getUtcMonthStart(Date.now());
    }
    const [yearRaw, monthRaw] = monthKey.split('-');
    const year = toNum(yearRaw, 1970);
    const monthIndex = toNum(monthRaw, 1) - 1;
    return Date.UTC(year, monthIndex, 1, 0, 0, 0, 0);
}

function computeReconciliation({
    nav,
    capital,
    pnl,
    fees = 0,
    investorValue = 0,
    unitsValue = null,
    tolerance = 0.01,
}) {
    const navValue = toNum(nav, 0);
    const capitalValue = toNum(capital, 0);
    const pnlValue = toNum(pnl, 0);
    const feesValue = toNum(fees, 0);
    const investorValueTotal = toNum(investorValue, 0);
    const tol = Math.max(0, toNum(tolerance, 0.01));

    const navByFormula = capitalValue + pnlValue - feesValue;
    const navResidual = navValue - navByFormula;
    const investorResidual = navValue - investorValueTotal;
    const unitsResidual = unitsValue === null || unitsValue === undefined
        ? null
        : navValue - toNum(unitsValue, 0);

    return {
        navByFormula: round2(navByFormula),
        navResidual: round4(navResidual),
        investorResidual: round4(investorResidual),
        unitsResidual: unitsResidual === null ? null : round4(unitsResidual),
        isNavBalanced: Math.abs(navResidual) <= tol,
        isInvestorLedgerBalanced: Math.abs(investorResidual) <= tol,
        isUnitsBalanced: unitsResidual === null ? null : Math.abs(unitsResidual) <= tol,
        tolerance: round4(tol),
    };
}

module.exports = {
    toNum,
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
    summarizeTradeLifecycle,
    buildInvestorPerformanceHistory,
    calculatePeriodReturn,
    getUtcMonthStart,
    shiftUtcMonth,
    getUtcMonthEnd,
    formatMonthKey,
    formatMonthLabel,
    parseMonthKeyToUtcMonthStart,
    computeReconciliation,
};
