# Railway Rollout Checklist

## Required Environment Variables
- `DATABASE_URL_DIRECT`
- `DATABASE_URL_POOLER`
- `DB_CONNECT_MODE=direct`
- `DB_FALLBACK_ENABLED=true`
- `DB_CONNECT_TIMEOUT_MS=5000`
- `DB_RETRY_MAX_ATTEMPTS=5`
- `DB_RETRY_BASE_MS=250`
- `DB_RETRY_MAX_MS=5000`
- `PAUSE_BACKGROUND_ON_DB_DOWN=true`
- `NODE_OPTIONS=--dns-result-order=ipv4first`

## Deploy Validation
1. Deploy with both direct and pooler URLs configured.
2. Verify `GET /healthz` returns `status: ok`.
3. Verify `GET /readyz` returns `status: ready` and `db.connected: true`.
4. Run login flow and place one order.
5. Confirm no repeated `ENETUNREACH` spam in Railway logs.

## TLS Certificate Chain Troubleshooting
If health shows `lastErrorCode: SELF_SIGNED_CERT_IN_CHAIN`:
1. Set `DB_CONNECT_MODE=pooler`.
2. Set `DB_SSL_REJECT_UNAUTHORIZED=false` (temporary compatibility mode).
3. Redeploy and verify `GET /readyz` shows `db.connected: true`.
4. Later, re-enable strict TLS by setting `DB_SSL_REJECT_UNAUTHORIZED=true` once a trusted CA chain is provided.

## Fallback Validation
1. Temporarily break direct DB connectivity.
2. Verify `db.mode` shifts to `pooler` in health responses.
3. Verify app remains up and login/order APIs keep responding.

## Rollback
1. Restore previous Railway deployment.
2. Restore previous Railway env snapshot.
3. Confirm `GET /healthz` and login flow are healthy again.
