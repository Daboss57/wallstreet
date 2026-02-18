const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'streetos.db'));

// Ultra low latency: WAL mode + synchronous NORMAL + large cache
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64MB cache
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 268435456'); // 256MB mmap

// ─── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    cash REAL NOT NULL DEFAULT 100000,
    starting_cash REAL NOT NULL DEFAULT 100000,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0,
    opened_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, ticker)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    type TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    filled_qty REAL NOT NULL DEFAULT 0,
    limit_price REAL,
    stop_price REAL,
    trail_pct REAL,
    trail_high REAL,
    oco_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    avg_fill_price REAL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    filled_at INTEGER,
    cancelled_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    total REAL NOT NULL,
    pnl REAL DEFAULT 0,
    executed_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS candles (
    ticker TEXT NOT NULL,
    interval TEXT NOT NULL,
    open_time INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (ticker, interval, open_time)
  );

  CREATE TABLE IF NOT EXISTS news_events (
    id TEXT PRIMARY KEY,
    ticker TEXT,
    type TEXT NOT NULL,
    headline TEXT NOT NULL,
    body TEXT,
    price_impact REAL DEFAULT 0,
    severity TEXT DEFAULT 'normal',
    fired_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    total_value REAL NOT NULL,
    cash REAL NOT NULL,
    positions_value REAL NOT NULL,
    snapshot_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS price_state (
    ticker TEXT PRIMARY KEY,
    price REAL NOT NULL,
    bid REAL NOT NULL,
    ask REAL NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    prev_close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    volatility REAL NOT NULL DEFAULT 0.02,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_orders_ticker_status ON orders(ticker, status);
  CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(ticker, interval, open_time);
  CREATE INDEX IF NOT EXISTS idx_news_ticker ON news_events(ticker);
  CREATE INDEX IF NOT EXISTS idx_snapshots_user ON portfolio_snapshots(user_id, snapshot_at);
`);

// ─── Prepared Statements ───────────────────────────────────────────────────────
const stmts = {
  // Users
  insertUser: db.prepare(`INSERT INTO users (id, username, password_hash, cash, starting_cash) VALUES (?, ?, ?, ?, ?)`),
  getUserByUsername: db.prepare(`SELECT * FROM users WHERE username = ?`),
  getUserById: db.prepare(`SELECT id, username, cash, starting_cash, role, created_at FROM users WHERE id = ?`),
  updateUserCash: db.prepare(`UPDATE users SET cash = ? WHERE id = ?`),
  getAllUsers: db.prepare(`SELECT id, username, cash, starting_cash, role, created_at FROM users`),

  // Positions
  getPosition: db.prepare(`SELECT * FROM positions WHERE user_id = ? AND ticker = ?`),
  getUserPositions: db.prepare(`SELECT * FROM positions WHERE user_id = ?`),
  upsertPosition: db.prepare(`
    INSERT INTO positions (id, user_id, ticker, qty, avg_cost, opened_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, ticker) DO UPDATE SET qty = ?, avg_cost = ?, opened_at = ?
  `),
  deletePosition: db.prepare(`DELETE FROM positions WHERE user_id = ? AND ticker = ?`),

  // Orders
  insertOrder: db.prepare(`
    INSERT INTO orders (id, user_id, ticker, type, side, qty, limit_price, stop_price, trail_pct, trail_high, oco_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getOpenOrders: db.prepare(`SELECT * FROM orders WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC`),
  getOpenOrdersByTicker: db.prepare(`SELECT * FROM orders WHERE ticker = ? AND status = 'open'`),
  getAllOpenOrders: db.prepare(`SELECT * FROM orders WHERE status = 'open'`),
  updateOrderStatus: db.prepare(`UPDATE orders SET status = ?, filled_qty = ?, avg_fill_price = ?, filled_at = ? WHERE id = ?`),
  updateOrderTrailHigh: db.prepare(`UPDATE orders SET trail_high = ? WHERE id = ?`),
  cancelOrder: db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?`),
  cancelOcoOrders: db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE oco_id = ? AND id != ? AND status = 'open'`),
  getOrderById: db.prepare(`SELECT * FROM orders WHERE id = ?`),

  // Trades
  insertTrade: db.prepare(`INSERT INTO trades (id, order_id, user_id, ticker, side, qty, price, total, pnl, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getUserTrades: db.prepare(`SELECT * FROM trades WHERE user_id = ? ORDER BY executed_at DESC LIMIT ?`),

  // Candles
  upsertCandle: db.prepare(`
    INSERT INTO candles (ticker, interval, open_time, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, interval, open_time) DO UPDATE SET
      high = MAX(candles.high, ?), low = MIN(candles.low, ?), close = ?, volume = candles.volume + ?
  `),
  getCandles: db.prepare(`SELECT * FROM candles WHERE ticker = ? AND interval = ? ORDER BY open_time DESC LIMIT ?`),

  // News
  insertNews: db.prepare(`INSERT INTO news_events (id, ticker, type, headline, body, price_impact, severity, fired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  getRecentNews: db.prepare(`SELECT * FROM news_events ORDER BY fired_at DESC LIMIT ?`),
  getNewsByTicker: db.prepare(`SELECT * FROM news_events WHERE ticker = ? ORDER BY fired_at DESC LIMIT ?`),

  // Price state
  upsertPriceState: db.prepare(`
    INSERT INTO price_state (ticker, price, bid, ask, open, high, low, prev_close, volume, volatility, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      price = ?, bid = ?, ask = ?, open = ?, high = ?, low = ?, prev_close = ?, volume = ?, volatility = ?, updated_at = ?
  `),
  getPriceState: db.prepare(`SELECT * FROM price_state WHERE ticker = ?`),
  getAllPriceStates: db.prepare(`SELECT * FROM price_state`),

  // Portfolio snapshots
  insertSnapshot: db.prepare(`INSERT INTO portfolio_snapshots (user_id, total_value, cash, positions_value, snapshot_at) VALUES (?, ?, ?, ?, ?)`),
  getUserSnapshots: db.prepare(`SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY snapshot_at DESC LIMIT ?`),
};

// ─── Transaction helpers for batch operations ──────────────────────────────────
const batchUpsertCandles = db.transaction((candles) => {
  for (const c of candles) {
    stmts.upsertCandle.run(c.ticker, c.interval, c.openTime, c.open, c.high, c.low, c.close, c.volume, c.high, c.low, c.close, c.volume);
  }
});

const batchUpsertPriceStates = db.transaction((states) => {
  for (const s of states) {
    stmts.upsertPriceState.run(
      s.ticker, s.price, s.bid, s.ask, s.open, s.high, s.low, s.prevClose, s.volume, s.volatility, s.updatedAt,
      s.price, s.bid, s.ask, s.open, s.high, s.low, s.prevClose, s.volume, s.volatility, s.updatedAt
    );
  }
});

module.exports = { db, stmts, batchUpsertCandles, batchUpsertPriceStates };
