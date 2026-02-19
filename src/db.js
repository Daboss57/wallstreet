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

CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_ticker_status ON orders(ticker, status);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(ticker, "interval", open_time);
CREATE INDEX IF NOT EXISTS idx_news_ticker ON news_events(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON portfolio_snapshots(user_id, snapshot_at);
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
    await runInTransaction('batchUpsertCandles', async (client) => {
        for (const candle of candles) {
            await client.query(SQL.upsertCandle, [
                candle.ticker,
                candle.interval,
                candle.openTime,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
            ]);
        }
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
