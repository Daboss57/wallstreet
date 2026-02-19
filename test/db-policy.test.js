const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isConnectivityError,
    chooseModeForAttempt,
    chooseModeAfterFailure,
    nextRetryDelay,
} = require('../src/db/policy');

test('chooseModeForAttempt keeps direct when direct is active and healthy', () => {
    const mode = chooseModeForAttempt({
        activeMode: 'direct',
        defaultMode: 'direct',
        hasDirect: true,
        lastDirectFailureAt: Date.now(),
        cooldownMs: 60000,
        now: Date.now(),
    });
    assert.equal(mode, 'direct');
});

test('chooseModeAfterFailure falls back to pooler on connectivity failures', () => {
    const fallbackMode = chooseModeAfterFailure({
        mode: 'direct',
        fallbackEnabled: true,
        hasPooler: true,
        isConnectivityIssue: isConnectivityError({ code: 'ENETUNREACH' }),
    });
    assert.equal(fallbackMode, 'pooler');
});

test('nextRetryDelay honors max cap', () => {
    assert.equal(nextRetryDelay(250, 5000), 500);
    assert.equal(nextRetryDelay(4000, 5000), 5000);
    assert.equal(nextRetryDelay(5000, 5000), 5000);
});

test('chooseModeForAttempt resumes direct after cooldown elapsed', () => {
    const now = Date.now();
    const modeBeforeCooldown = chooseModeForAttempt({
        activeMode: 'pooler',
        defaultMode: 'direct',
        hasDirect: true,
        lastDirectFailureAt: now - 1000,
        cooldownMs: 60000,
        now,
    });
    assert.equal(modeBeforeCooldown, 'pooler');

    const modeAfterCooldown = chooseModeForAttempt({
        activeMode: 'pooler',
        defaultMode: 'direct',
        hasDirect: true,
        lastDirectFailureAt: now - 61000,
        cooldownMs: 60000,
        now,
    });
    assert.equal(modeAfterCooldown, 'direct');
});
