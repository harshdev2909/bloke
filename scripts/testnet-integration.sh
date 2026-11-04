#!/usr/bin/env bash
# Runs the integration loop against the testnet staging set (services must be running).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env.testnet"; [ -f "$ROOT/.env.db" ] && source "$ROOT/.env.db"; set +a
# Each staging deployment indexes into its own database (same server, name from STAGING_DB_NAME).
[ -n "${DATABASE_URL_OVERRIDE:-}" ] && export DATABASE_URL="$DATABASE_URL_OVERRIDE"
if [ -n "${STAGING_DB_NAME:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#^(postgres(ql)?://[^/]+/)[^?]*#\1$STAGING_DB_NAME#")"
fi
export ADDRESSES="$ROOT/contracts/deployments/10143-staging.json"
# A test wallet spends ~0.2 MON across its 6 transactions.
export DRIP_MON="${DRIP_MON:-0.25}"
export API_URL="${API_URL:-http://127.0.0.1:8080}" API_URL_B="${API_URL_B:-http://127.0.0.1:8081}" MOCK_OAUTH_PORT="${MOCK_OAUTH_PORT:-18555}"
cd "$ROOT/tests/integration" && pnpm -s integration
