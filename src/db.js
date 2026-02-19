const {
    initDb: initConnection,
    withDbRetry,
    probeDb,
    getDbStatus,
    getDbDiagnostics,
    isDbHealthy,
    isDbUnavailableError,
    closeDb,
} = require('./db/connection');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  cash DOUBLE PRECISION NOT NULL DEFAULT 100000,
  starting_cash DOUBLE PRECISION NOT NULL DEFAULT 100000,
  role TEXT NOT NULL DEFAULT 'user',
  created_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  opened_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint),
  UNIQUE(user_id, ticker)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,
  type TEXT NOT NULL,
  side TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  filled_qty DOUBLE PRECISION NOT NULL DEFAULT 0,
  limit_price DOUBLE PRECISION,
  stop_price DOUBLE PRECISION,
  trail_pct DOUBLE PRECISION,
  trail_high DOUBLE PRECISION,
  oco_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  avg_fill_price DOUBLE PRECISION,
  created_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint),
  filled_at BIGINT,
  cancelled_at BIGINT
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  total DOUBLE PRECISION NOT NULL,
  pnl DOUBLE PRECISION DEFAULT 0,
  executed_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS candles (
  ticker TEXT NOT NULL,
  "interval" TEXT NOT NULL,
  open_time BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (ticker, "interval", open_time)
);

CREATE TABLE IF NOT EXISTS news_events (
  id TEXT PRIMARY KEY,
  ticker TEXT,
  type TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT,
  price_impact DOUBLE PRECISION DEFAULT 0,
  severity TEXT DEFAULT 'normal',
  fired_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  total_value DOUBLE PRECISION NOT NULL,
  cash DOUBLE PRECISION NOT NULL,
  positions_value DOUBLE PRECISION NOT NULL,
  snapshot_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS price_state (
  ticker TEXT PRIMARY KEY,
  price DOUBLE PRECISION NOT NULL,
  bid DOUBLE PRECISION NOT NULL,
  ask DOUBLE PRECISION NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  prev_close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  volatility DOUBLE PRECISION NOT NULL DEFAULT 0.02,
  updated_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS funds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  strategy_type TEXT NOT NULL,
  description TEXT,
  min_investment DOUBLE PRECISION NOT NULL DEFAULT 0,
  management_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  performance_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS fund_members (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  joined_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint),
  UNIQUE(fund_id, user_id)
);

CREATE TABLE IF NOT EXISTS fund_capital (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  amount DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  fund_id TEXT NOT NULL REFERENCES funds(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mean_reversion', 'momentum', 'grid', 'pairs', 'custom')),
  config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint),
  updated_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE TABLE IF NOT EXISTS strategy_trades (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  executed_at BIGINT NOT NULL DEFAULT ((extract(epoch from now()) * 1000)::bigint)
);

CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_ticker_status ON orders(ticker, status);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(ticker, "interval", open_time);
CREATE INDEX IF NOT EXISTS idx_news_ticker ON news_events(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON portfolio_snapshots(user_id, snapshot_at);
CREATE INDEX IF NOT EXISTS idx_funds_owner ON funds(owner_id);
CREATE INDEX IF NOT EXISTS idx_fund_members_fund ON fund_members(fund_id);
CREATE INDEX IF NOT EXISTS idx_fund_members_user ON fund_members(user_id);
CREATE INDEX IF NOT EXISTS idx_fund_capital_fund ON fund_capital(fund_id);
CREATE INDEX IF NOT EXISTS idx_fund_capital_user ON fund_capital(user_id, fund_id);
CREATE INDEX IF NOT EXISTS idx_strategies_fund ON strategies(fund_id);
CREATE INDEX IF NOT EXISTS idx_strategies_type ON strategies(type);
CREATE INDEX IF NOT EXISTS idx_strategy_trades_strategy ON strategy_trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_trades_ticker ON strategy_trades(ticker);
`;

const SQL = {
    insertUser: 'INSERT INTO users (id, username, password_hash, cash, starting_cash) VALUES ($1, $2, $3, $4, $5)',
    getUserByUsername: 'SELECT * FROM users WHERE username = $1',
    getUserById: 'SELECT id, username, cash, starting_cash, role, created_at FROM users WHERE id = $1',
    updateUserCash: 'UPDATE users SET cash = $1 WHERE id = $2',
    getAllUsers: 'SELECT id, username, cash, starting_cash, role, created_at FROM users',
    getPosition: 'SELECT * FROM positions WHERE user_id = $1 AND ticker = $2',
    getUserPositions: 'SELECT * FROM positions WHERE user_id = $1',
    getAllPositions: 'SELECT * FROM positions',
    upsertPosition: `
        INSERT INTO positions (id, user_id, ticker, qty, avg_cost, opened_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(user_id, ticker) DO UPDATE SET
            qty = EXCLUDED.qty,
            avg_cost = EXCLUDED.avg_cost,
            opened_at = EXCLUDED.opened_at
    `,
    deletePosition: 'DELETE FROM positions WHERE user_id = $1 AND ticker = $2',
    insertOrder: `
        INSERT INTO orders (
            id, user_id, ticker, type, side, qty, limit_price, stop_price, trail_pct, trail_high, oco_id, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `,
    getOpenOrders: "SELECT * FROM orders WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC",
    getOpenOrdersByTicker: "SELECT * FROM orders WHERE ticker = $1 AND status = 'open'",
    getAllOpenOrders: "SELECT * FROM orders WHERE status = 'open'",
    updateOrderStatus: 'UPDATE orders SET status = $1, filled_qty = $2, avg_fill_price = $3, filled_at = $4 WHERE id = $5',
    updateOrderTrailHigh: 'UPDATE orders SET trail_high = $1 WHERE id = $2',
    cancelOrder: "UPDATE orders SET status = 'cancelled', cancelled_at = $1 WHERE id = $2",
    cancelOcoOrders: "UPDATE orders SET status = 'cancelled', cancelled_at = $1 WHERE oco_id = $2 AND id != $3 AND status = 'open'",
    getOrderById: 'SELECT * FROM orders WHERE id = $1',
    insertTrade: `
        INSERT INTO trades (id, order_id, user_id, ticker, side, qty, price, total, pnl, executed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    getUserTrades: 'SELECT * FROM trades WHERE user_id = $1 ORDER BY executed_at DESC LIMIT $2',
    getAllTrades: 'SELECT * FROM trades ORDER BY user_id, executed_at DESC',
    upsertCandle: `
        INSERT INTO candles (ticker, "interval", open_time, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(ticker, "interval", open_time) DO UPDATE SET
            high = GREATEST(candles.high, EXCLUDED.high),
            low = LEAST(candles.low, EXCLUDED.low),
            close = EXCLUDED.close,
            volume = candles.volume + EXCLUDED.volume
    `,
    getCandles: 'SELECT * FROM candles WHERE ticker = $1 AND "interval" = $2 ORDER BY open_time DESC LIMIT $3',
    insertNews: `
        INSERT INTO news_events (id, ticker, type, headline, body, price_impact, severity, fired_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    getRecentNews: 'SELECT * FROM news_events ORDER BY fired_at DESC LIMIT $1',
    getNewsByTicker: 'SELECT * FROM news_events WHERE ticker = $1 ORDER BY fired_at DESC LIMIT $2',
    upsertPriceState: `
        INSERT INTO price_state (ticker, price, bid, ask, open, high, low, prev_close, volume, volatility, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT(ticker) DO UPDATE SET
            price = EXCLUDED.price,
            bid = EXCLUDED.bid,
            ask = EXCLUDED.ask,
            open = EXCLUDED.open,
            high = EXCLUDED.high,
            low = EXCLUDED.low,
            prev_close = EXCLUDED.prev_close,
            volume = EXCLUDED.volume,
            volatility = EXCLUDED.volatility,
            updated_at = EXCLUDED.updated_at
    `,
    getPriceState: 'SELECT * FROM price_state WHERE ticker = $1',
    getAllPriceStates: 'SELECT * FROM price_state',
    insertSnapshot: `
        INSERT INTO portfolio_snapshots (user_id, total_value, cash, positions_value, snapshot_at)
        VALUES ($1, $2, $3, $4, $5)
    `,
    getUserSnapshots: 'SELECT * FROM portfolio_snapshots WHERE user_id = $1 ORDER BY snapshot_at DESC LIMIT $2',

    // Fund CRUD
    insertFund: 'INSERT INTO funds (id, name, owner_id, strategy_type, description, min_investment, management_fee, performance_fee, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    getFundById: 'SELECT * FROM funds WHERE id = $1',
    getFundsByOwner: 'SELECT * FROM funds WHERE owner_id = $1 ORDER BY created_at DESC',
    getAllFunds: 'SELECT * FROM funds ORDER BY created_at DESC',
    updateFund: 'UPDATE funds SET name = $1, strategy_type = $2, description = $3, min_investment = $4, management_fee = $5, performance_fee = $6 WHERE id = $7',
    deleteFund: 'DELETE FROM funds WHERE id = $1',

    // Fund Member CRUD
    insertFundMember: 'INSERT INTO fund_members (id, fund_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4, $5)',
    getFundMember: 'SELECT * FROM fund_members WHERE fund_id = $1 AND user_id = $2',
    getFundMembers: 'SELECT fm.*, u.username FROM fund_members fm JOIN users u ON fm.user_id = u.id WHERE fm.fund_id = $1 ORDER BY fm.joined_at DESC',
    getUserFunds: 'SELECT f.*, fm.role FROM funds f JOIN fund_members fm ON f.id = fm.fund_id WHERE fm.user_id = $1 ORDER BY fm.joined_at DESC',
    updateFundMemberRole: 'UPDATE fund_members SET role = $1 WHERE fund_id = $2 AND user_id = $3',
    deleteFundMember: 'DELETE FROM fund_members WHERE fund_id = $1 AND user_id = $2',

    // Fund Capital CRUD
    insertFundCapital: 'INSERT INTO fund_capital (id, fund_id, user_id, amount, type, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    getFundCapitalById: 'SELECT * FROM fund_capital WHERE id = $1',
    getFundCapitalTransactions: 'SELECT fc.*, u.username FROM fund_capital fc JOIN users u ON fc.user_id = u.id WHERE fc.fund_id = $1 ORDER BY fc.created_at DESC',
    getUserCapitalInFund: 'SELECT * FROM fund_capital WHERE fund_id = $1 AND user_id = $2 ORDER BY created_at DESC',
    getFundCapitalSummary: 'SELECT user_id, SUM(CASE WHEN type = $2 THEN amount ELSE -amount END) as total_capital FROM fund_capital WHERE fund_id = $1 GROUP BY user_id',

    // Strategy CRUD
    insertStrategy: 'INSERT INTO strategies (id, fund_id, name, type, config, is_active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    getStrategyById: 'SELECT * FROM strategies WHERE id = $1',
    getStrategiesByFund: 'SELECT * FROM strategies WHERE fund_id = $1 ORDER BY created_at DESC',
    getActiveStrategies: 'SELECT * FROM strategies WHERE is_active = true ORDER BY created_at DESC',
    updateStrategy: 'UPDATE strategies SET name = $1, type = $2, config = $3, is_active = $4, updated_at = $5 WHERE id = $6',
    deleteStrategy: 'DELETE FROM strategies WHERE id = $1',

    // Strategy Trade CRUD
    insertStrategyTrade: 'INSERT INTO strategy_trades (id, strategy_id, ticker, side, quantity, price, executed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    getStrategyTrades: 'SELECT * FROM strategy_trades WHERE strategy_id = $1 ORDER BY executed_at DESC LIMIT $2',
    getStrategyTradesByTicker: 'SELECT * FROM strategy_trades WHERE strategy_id = $1 AND ticker = $2 ORDER BY executed_at DESC',
};

let dbInitialized = false;

async function initDb() {
    if (dbInitialized) return getDbStatus();
    await initConnection();
    await withDbRetry('init_schema', async ({ pool }) => {
        await pool.query(SCHEMA_SQL);
    });
    dbInitialized = true;
    return getDbStatus();
}

async function queryRun(operationName, text, params) {
    return withDbRetry(operationName, async ({ pool }) => {
        return pool.query(text, params);
    });
}

async function queryGet(operationName, text, params) {
    const result = await withDbRetry(operationName, async ({ pool }) => {
        return pool.query(text, params);
    });
    return result.rows[0] || null;
}

async function queryAll(operationName, text, params) {
    const result = await withDbRetry(operationName, async ({ pool }) => {
        return pool.query(text, params);
    });
    return result.rows;
}

function makeStatement(name, sql) {
    return {
        run: (...params) => queryRun(`${name}.run`, sql, params),
        get: (...params) => queryGet(`${name}.get`, sql, params),
        all: (...params) => queryAll(`${name}.all`, sql, params),
    };
}

const stmts = {
    insertUser: makeStatement('insertUser', SQL.insertUser),
    getUserByUsername: makeStatement('getUserByUsername', SQL.getUserByUsername),
    getUserById: makeStatement('getUserById', SQL.getUserById),
    updateUserCash: makeStatement('updateUserCash', SQL.updateUserCash),
    getAllUsers: makeStatement('getAllUsers', SQL.getAllUsers),
    getPosition: makeStatement('getPosition', SQL.getPosition),
    getUserPositions: makeStatement('getUserPositions', SQL.getUserPositions),
    getAllPositions: makeStatement('getAllPositions', SQL.getAllPositions),
    upsertPosition: makeStatement('upsertPosition', SQL.upsertPosition),
    deletePosition: makeStatement('deletePosition', SQL.deletePosition),
    insertOrder: makeStatement('insertOrder', SQL.insertOrder),
    getOpenOrders: makeStatement('getOpenOrders', SQL.getOpenOrders),
    getOpenOrdersByTicker: makeStatement('getOpenOrdersByTicker', SQL.getOpenOrdersByTicker),
    getAllOpenOrders: makeStatement('getAllOpenOrders', SQL.getAllOpenOrders),
    updateOrderStatus: makeStatement('updateOrderStatus', SQL.updateOrderStatus),
    updateOrderTrailHigh: makeStatement('updateOrderTrailHigh', SQL.updateOrderTrailHigh),
    cancelOrder: makeStatement('cancelOrder', SQL.cancelOrder),
    cancelOcoOrders: makeStatement('cancelOcoOrders', SQL.cancelOcoOrders),
    getOrderById: makeStatement('getOrderById', SQL.getOrderById),
    insertTrade: makeStatement('insertTrade', SQL.insertTrade),
    getUserTrades: makeStatement('getUserTrades', SQL.getUserTrades),
    getAllTrades: makeStatement('getAllTrades', SQL.getAllTrades),
    upsertCandle: makeStatement('upsertCandle', SQL.upsertCandle),
    getCandles: makeStatement('getCandles', SQL.getCandles),
    insertNews: makeStatement('insertNews', SQL.insertNews),
    getRecentNews: makeStatement('getRecentNews', SQL.getRecentNews),
    getNewsByTicker: makeStatement('getNewsByTicker', SQL.getNewsByTicker),
    upsertPriceState: makeStatement('upsertPriceState', SQL.upsertPriceState),
    getPriceState: makeStatement('getPriceState', SQL.getPriceState),
    getAllPriceStates: makeStatement('getAllPriceStates', SQL.getAllPriceStates),
    insertSnapshot: makeStatement('insertSnapshot', SQL.insertSnapshot),
    getUserSnapshots: makeStatement('getUserSnapshots', SQL.getUserSnapshots),

    // Fund CRUD
    insertFund: makeStatement('insertFund', SQL.insertFund),
    getFundById: makeStatement('getFundById', SQL.getFundById),
    getFundsByOwner: makeStatement('getFundsByOwner', SQL.getFundsByOwner),
    getAllFunds: makeStatement('getAllFunds', SQL.getAllFunds),
    updateFund: makeStatement('updateFund', SQL.updateFund),
    deleteFund: makeStatement('deleteFund', SQL.deleteFund),

    // Fund Member CRUD
    insertFundMember: makeStatement('insertFundMember', SQL.insertFundMember),
    getFundMember: makeStatement('getFundMember', SQL.getFundMember),
    getFundMembers: makeStatement('getFundMembers', SQL.getFundMembers),
    getUserFunds: makeStatement('getUserFunds', SQL.getUserFunds),
    updateFundMemberRole: makeStatement('updateFundMemberRole', SQL.updateFundMemberRole),
    deleteFundMember: makeStatement('deleteFundMember', SQL.deleteFundMember),

    // Fund Capital CRUD
    insertFundCapital: makeStatement('insertFundCapital', SQL.insertFundCapital),
    getFundCapitalById: makeStatement('getFundCapitalById', SQL.getFundCapitalById),
    getFundCapitalTransactions: makeStatement('getFundCapitalTransactions', SQL.getFundCapitalTransactions),
    getUserCapitalInFund: makeStatement('getUserCapitalInFund', SQL.getUserCapitalInFund),
    getFundCapitalSummary: makeStatement('getFundCapitalSummary', SQL.getFundCapitalSummary),

    // Strategy CRUD
    insertStrategy: makeStatement('insertStrategy', SQL.insertStrategy),
    getStrategyById: makeStatement('getStrategyById', SQL.getStrategyById),
    getStrategiesByFund: makeStatement('getStrategiesByFund', SQL.getStrategiesByFund),
    getActiveStrategies: makeStatement('getActiveStrategies', SQL.getActiveStrategies),
    updateStrategy: makeStatement('updateStrategy', SQL.updateStrategy),
    deleteStrategy: makeStatement('deleteStrategy', SQL.deleteStrategy),

    // Strategy Trade CRUD
    insertStrategyTrade: makeStatement('insertStrategyTrade', SQL.insertStrategyTrade),
    getStrategyTrades: makeStatement('getStrategyTrades', SQL.getStrategyTrades),
    getStrategyTradesByTicker: makeStatement('getStrategyTradesByTicker', SQL.getStrategyTradesByTicker),
};

async function runInTransaction(operationName, transactionFn) {
    return withDbRetry(operationName, async ({ pool }) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await transactionFn(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Ignore rollback errors to preserve original error.
            }
            throw error;
        } finally {
            client.release();
        }
    });
}

async function batchUpsertCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    
    const sql = `
        INSERT INTO candles (ticker, "interval", open_time, open, high, low, close, volume)
        SELECT * FROM UNNEST(
            $1::text[],
            $2::text[],
            $3::bigint[],
            $4::double precision[],
            $5::double precision[],
            $6::double precision[],
            $7::double precision[],
            $8::double precision[]
        )
        ON CONFLICT(ticker, "interval", open_time) DO UPDATE SET
            high = GREATEST(candles.high, EXCLUDED.high),
            low = LEAST(candles.low, EXCLUDED.low),
            close = EXCLUDED.close,
            volume = candles.volume + EXCLUDED.volume
    `;
    
    await withDbRetry('batchUpsertCandles', async ({ pool }) => {
        await pool.query(sql, [
            candles.map(c => c.ticker),
            candles.map(c => c.interval),
            candles.map(c => c.openTime),
            candles.map(c => c.open),
            candles.map(c => c.high),
            candles.map(c => c.low),
            candles.map(c => c.close),
            candles.map(c => c.volume),
        ]);
    });
}

async function batchUpsertPriceStates(states) {
    if (!Array.isArray(states) || states.length === 0) return;
    await runInTransaction('batchUpsertPriceStates', async (client) => {
        for (const state of states) {
            await client.query(SQL.upsertPriceState, [
                state.ticker,
                state.price,
                state.bid,
                state.ask,
                state.open,
                state.high,
                state.low,
                state.prevClose,
                state.volume,
                state.volatility,
                state.updatedAt,
            ]);
        }
    });
}

module.exports = {
    initDb,
    closeDb,
    probeDb,
    getDbStatus,
    getDbDiagnostics,
    isDbHealthy,
    isDbUnavailableError,
    withDbRetry,
    stmts,
    batchUpsertCandles,
    batchUpsertPriceStates,
};
