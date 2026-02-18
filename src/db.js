const { Pool } = require('pg');
const dns = require('dns');

// Force IPv4 if available to avoid ENETUNREACH on dual-stack environments with bad routing
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/streetos';
const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

// ─── Schema ────────────────────────────────────────────────────────────────────
const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    cash DOUBLE PRECISION NOT NULL DEFAULT 100000,
    starting_cash DOUBLE PRECISION NOT NULL DEFAULT 100000,
    role TEXT NOT NULL DEFAULT 'user',
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
  );

  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    ticker TEXT NOT NULL,
    qty DOUBLE PRECISION NOT NULL DEFAULT 0,
    avg_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
    opened_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
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
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
    filled_at BIGINT,
    cancelled_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    qty DOUBLE PRECISION NOT NULL,
    price DOUBLE PRECISION NOT NULL,
    total DOUBLE PRECISION NOT NULL,
    pnl DOUBLE PRECISION DEFAULT 0,
    executed_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
  );

  CREATE TABLE IF NOT EXISTS candles (
    ticker TEXT NOT NULL,
    interval TEXT NOT NULL,
    open_time BIGINT NOT NULL,
    open DOUBLE PRECISION NOT NULL,
    high DOUBLE PRECISION NOT NULL,
    low DOUBLE PRECISION NOT NULL,
    close DOUBLE PRECISION NOT NULL,
    volume DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (ticker, interval, open_time)
  );

  CREATE TABLE IF NOT EXISTS news_events (
    id TEXT PRIMARY KEY,
    ticker TEXT,
    type TEXT NOT NULL,
    headline TEXT NOT NULL,
    body TEXT,
    price_impact DOUBLE PRECISION DEFAULT 0,
    severity TEXT DEFAULT 'normal',
    fired_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
  );

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    total_value DOUBLE PRECISION NOT NULL,
    cash DOUBLE PRECISION NOT NULL,
    positions_value DOUBLE PRECISION NOT NULL,
    snapshot_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
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
    updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
  );
  
  CREATE TABLE IF NOT EXISTS firms (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    description TEXT,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
  );

  CREATE TABLE IF NOT EXISTS firm_members (
    firm_id TEXT NOT NULL REFERENCES firms(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member', -- member, analyst, manager
    joined_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000),
    PRIMARY KEY (firm_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS firm_invitations (
    id TEXT PRIMARY KEY,
    firm_id TEXT NOT NULL REFERENCES firms(id),
    inviter_id TEXT NOT NULL REFERENCES users(id),
    invitee_username TEXT NOT NULL, 
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_orders_ticker_status ON orders(ticker, status);
  CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(ticker, interval, open_time);
  CREATE INDEX IF NOT EXISTS idx_news_ticker ON news_events(ticker);
  CREATE INDEX IF NOT EXISTS idx_snapshots_user ON portfolio_snapshots(user_id, snapshot_at);
  CREATE INDEX IF NOT EXISTS idx_firm_members_user ON firm_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_firm_invitations_invitee ON firm_invitations(invitee_username);
`;

// Initialize DB
(async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query(schema);
      console.log('[DB] PostgreSQL schema initialized');
    } finally {
      client.release();
    }
  } catch (e) {
    // If we get an error here, it's likely connection/dns related
    console.error('[DB] Init Error:', e.message);
  }
})();

// ─── Query Helpers ─────────────────────────────────────────────────────────────
const query = (text, params) => pool.query(text, params);

const getOne = async (text, params) => {
  const res = await pool.query(text, params);
  return res.rows[0];
};

const getAll = async (text, params) => {
  const res = await pool.query(text, params);
  return res.rows;
};

// ─── Batch Operations ──────────────────────────────────────────────────────────
const batchUpsertCandles = async (candles) => {
  if (candles.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const text = `
      INSERT INTO candles (ticker, interval, open_time, open, high, low, close, volume)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (ticker, interval, open_time) DO UPDATE SET
        high = GREATEST(candles.high, EXCLUDED.high),
        low = LEAST(candles.low, EXCLUDED.low),
        close = EXCLUDED.close,
        volume = candles.volume + EXCLUDED.volume
    `;
    for (const c of candles) {
      await client.query(text, [c.ticker, c.interval, c.openTime, c.open, c.high, c.low, c.close, c.volume]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Batch Candle Error:', e.message);
  } finally {
    client.release();
  }
};

const batchUpsertPriceStates = async (states) => {
  if (states.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const text = `
      INSERT INTO price_state (ticker, price, bid, ask, open, high, low, prev_close, volume, volatility, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (ticker) DO UPDATE SET
        price = EXCLUDED.price, bid = EXCLUDED.bid, ask = EXCLUDED.ask,
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
        prev_close = EXCLUDED.prev_close, volume = EXCLUDED.volume,
        volatility = EXCLUDED.volatility, updated_at = EXCLUDED.updated_at
    `;
    for (const s of states) {
      await client.query(text, [
        s.ticker, s.price, s.bid, s.ask, s.open, s.high, s.low,
        s.prevClose, s.volume, s.volatility, s.updatedAt
      ]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Batch Price State Error:', e.message);
  } finally {
    client.release();
  }
};

module.exports = { pool, query, getOne, getAll, batchUpsertCandles, batchUpsertPriceStates };
