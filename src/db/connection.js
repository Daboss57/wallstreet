const dns = require('dns');
const { URL } = require('url');
const { Pool } = require('pg');
const {
    isConnectivityError,
    chooseModeForAttempt,
    chooseModeAfterFailure,
    nextRetryDelay,
} = require('./policy');

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const DEFAULT_CONNECT_MODE = (process.env.DB_CONNECT_MODE || 'direct').toLowerCase() === 'pooler' ? 'pooler' : 'direct';
const DIRECT_URL = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL || '';
const POOLER_URL = process.env.DATABASE_URL_POOLER || '';
const DB_FALLBACK_ENABLED = parseBool(process.env.DB_FALLBACK_ENABLED, true);
const DB_CONNECT_TIMEOUT_MS = parseIntOr(process.env.DB_CONNECT_TIMEOUT_MS, 5000);
const DB_RETRY_MAX_ATTEMPTS = parseIntOr(process.env.DB_RETRY_MAX_ATTEMPTS, 5);
const DB_RETRY_BASE_MS = parseIntOr(process.env.DB_RETRY_BASE_MS, 250);
const DB_RETRY_MAX_MS = parseIntOr(process.env.DB_RETRY_MAX_MS, 5000);
const DB_POOL_MAX = parseIntOr(process.env.DB_POOL_MAX, 10);
const DB_DIRECT_RETRY_COOLDOWN_MS = parseIntOr(process.env.DB_DIRECT_RETRY_COOLDOWN_MS, 60000);

const listeners = new Set();
const pools = {
    direct: null,
    pooler: null,
};

let initialized = false;
let activeMode = DEFAULT_CONNECT_MODE;
let lastDirectFailureAt = 0;
let status = {
    connected: false,
    mode: activeMode,
    lastErrorCode: null,
    lastErrorMessage: null,
};

function parseBool(value, defaultValue) {
    if (value == null) return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function parseIntOr(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUrlForMode(mode) {
    if (mode === 'pooler') return POOLER_URL;
    return DIRECT_URL;
}

function ensureConfigured() {
    if (!DIRECT_URL && !POOLER_URL) {
        throw new Error('No database connection string configured. Set DATABASE_URL_DIRECT (or DATABASE_URL) and optionally DATABASE_URL_POOLER.');
    }
    if (activeMode === 'direct' && !DIRECT_URL && POOLER_URL) activeMode = 'pooler';
    if (activeMode === 'pooler' && !POOLER_URL && DIRECT_URL) activeMode = 'direct';
    status.mode = activeMode;
}

function markHealthy(mode) {
    const changed = !status.connected || status.mode !== mode || status.lastErrorCode !== null;
    status = {
        connected: true,
        mode,
        lastErrorCode: null,
        lastErrorMessage: null,
    };
    activeMode = mode;
    if (changed) notifyStatus();
}

function markUnhealthy(mode, error) {
    const next = {
        connected: false,
        mode,
        lastErrorCode: error?.code || 'UNKNOWN',
        lastErrorMessage: error?.message || 'unknown database error',
    };
    const changed =
        status.connected !== next.connected ||
        status.mode !== next.mode ||
        status.lastErrorCode !== next.lastErrorCode ||
        status.lastErrorMessage !== next.lastErrorMessage;
    status = next;
    if (changed) notifyStatus();
}

function notifyStatus() {
    for (const listener of listeners) {
        try {
            listener(getDbStatus());
        } catch (error) {
            console.error('[DB] Status listener failed:', error.message);
        }
    }
}

function onDbStatusChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getDbStatus() {
    return { ...status };
}

function isDbHealthy() {
    return status.connected;
}

function createPool(mode) {
    const connectionString = getUrlForMode(mode);
    if (!connectionString) return null;
    return new Pool({
        connectionString,
        max: DB_POOL_MAX,
        connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
        idleTimeoutMillis: 30000,
        ssl: { rejectUnauthorized: true },
        keepAlive: true,
    });
}

async function getPool(mode = activeMode) {
    ensureConfigured();
    if (!pools[mode]) {
        pools[mode] = createPool(mode);
    }
    if (!pools[mode]) {
        throw new Error(`Database mode "${mode}" is not configured`);
    }
    return pools[mode];
}

function makeUnavailableError(cause) {
    const error = new Error('db_unavailable');
    error.code = 'DB_UNAVAILABLE';
    error.cause = cause;
    return error;
}

function isDbUnavailableError(error) {
    return error?.code === 'DB_UNAVAILABLE';
}

async function withDbRetry(operationName, operationFn) {
    ensureConfigured();
    let delayMs = DB_RETRY_BASE_MS;
    let lastError = null;

    for (let attempt = 1; attempt <= DB_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const mode = chooseModeForAttempt({
            activeMode,
            defaultMode: DEFAULT_CONNECT_MODE,
            hasDirect: Boolean(DIRECT_URL),
            lastDirectFailureAt,
            cooldownMs: DB_DIRECT_RETRY_COOLDOWN_MS,
            now: Date.now(),
        });
        try {
            const pool = await getPool(mode);
            const result = await operationFn({ pool, mode, attempt });
            markHealthy(mode);
            return result;
        } catch (error) {
            lastError = error;
            const connectivityIssue = isConnectivityError(error);
            if (!connectivityIssue) throw error;

            markUnhealthy(mode, error);

            if (mode === 'direct') {
                lastDirectFailureAt = Date.now();
            }
            activeMode = chooseModeAfterFailure({
                mode,
                fallbackEnabled: DB_FALLBACK_ENABLED,
                hasPooler: Boolean(POOLER_URL),
                isConnectivityIssue: true,
            });

            if (attempt < DB_RETRY_MAX_ATTEMPTS) {
                const boundedDelay = Math.min(delayMs, DB_RETRY_MAX_MS);
                await sleep(boundedDelay);
                delayMs = nextRetryDelay(delayMs, DB_RETRY_MAX_MS);
                continue;
            }
        }
    }

    console.error(`[DB] ${operationName} failed after ${DB_RETRY_MAX_ATTEMPTS} attempts: ${lastError?.message || 'unknown error'}`);
    throw makeUnavailableError(lastError);
}

async function logHostResolution(label, connectionString) {
    if (!connectionString) return;
    let host = null;
    try {
        host = new URL(connectionString).hostname;
    } catch {
        return;
    }
    if (!host) return;
    try {
        const records = await dns.promises.lookup(host, { all: true });
        const families = records.map((record) => `IPv${record.family}:${record.address}`).join(', ');
        console.log(`[DB] ${label} host ${host} resolved to ${families}`);
    } catch (error) {
        console.warn(`[DB] ${label} DNS lookup failed for ${host}: ${error.message}`);
    }
}

async function initDb() {
    if (initialized) return getDbStatus();
    ensureConfigured();

    await Promise.all([
        logHostResolution('direct', DIRECT_URL),
        logHostResolution('pooler', POOLER_URL),
    ]);

    await withDbRetry('init_db', async ({ pool }) => {
        await pool.query('SELECT 1');
    });

    initialized = true;
    console.log(`[DB] Connected using mode: ${activeMode}`);
    return getDbStatus();
}

async function probeDb() {
    try {
        await withDbRetry('db_probe', async ({ pool }) => {
            await pool.query('SELECT 1');
        });
        return true;
    } catch (error) {
        return false;
    }
}

async function closeDb() {
    for (const mode of Object.keys(pools)) {
        const pool = pools[mode];
        if (!pool) continue;
        try {
            await pool.end();
        } catch (error) {
            console.error('[DB] Failed to close pool:', error.message);
        } finally {
            pools[mode] = null;
        }
    }
}

module.exports = {
    initDb,
    getPool,
    withDbRetry,
    probeDb,
    closeDb,
    onDbStatusChange,
    getDbStatus,
    isDbHealthy,
    isDbUnavailableError,
};
