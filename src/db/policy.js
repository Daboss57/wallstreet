const CONNECTIVITY_ERROR_CODES = new Set([
    'ENETUNREACH',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNABORTED',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    '08001',
    '08006',
    '57P01',
]);

const CONNECTIVITY_ERROR_PATTERNS = [
    'connect enetunreach',
    'connection terminated unexpectedly',
    'timeout expired',
    'could not connect to server',
    'self-signed certificate in certificate chain',
    'unable to verify the first certificate',
    'certificate has expired',
];

function isConnectivityError(error) {
    if (!error) return false;
    if (error.code && CONNECTIVITY_ERROR_CODES.has(error.code)) return true;
    const message = String(error.message || '').toLowerCase();
    return CONNECTIVITY_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function chooseModeForAttempt({ activeMode, defaultMode, hasDirect, lastDirectFailureAt, cooldownMs, now }) {
    if (activeMode === 'pooler' && defaultMode === 'direct' && hasDirect) {
        if (now - lastDirectFailureAt >= cooldownMs) {
            return 'direct';
        }
    }
    return activeMode;
}

function chooseModeAfterFailure({ mode, fallbackEnabled, hasPooler, isConnectivityIssue }) {
    if (!isConnectivityIssue) return mode;
    if (mode === 'direct' && fallbackEnabled && hasPooler) return 'pooler';
    return mode;
}

function nextRetryDelay(currentDelay, maxDelay) {
    return Math.min(currentDelay * 2, maxDelay);
}

module.exports = {
    isConnectivityError,
    chooseModeForAttempt,
    chooseModeAfterFailure,
    nextRetryDelay,
};
