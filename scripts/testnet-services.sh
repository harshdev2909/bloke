#!/usr/bin/env bash
# Runs indexer (if DATABASE_URL is set), oracle-pusher and keeper against the testnet staging set.
# Logs go to $LOGS (default ./.logs). Ctrl-C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env.testnet"; [ -f "$ROOT/.env.db" ] && source "$ROOT/.env.db"; set +a
# DATABASE_URL_OVERRIDE points every service at another server (e.g. local Postgres while Neon is down).
[ -n "${DATABASE_URL_OVERRIDE:-}" ] && export DATABASE_URL="$DATABASE_URL_OVERRIDE"
# Each staging deployment indexes into its own database (same server, name from STAGING_DB_NAME).
if [ -n "${STAGING_DB_NAME:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#^(postgres(ql)?://[^/]+/)[^?]*#\1$STAGING_DB_NAME#")"
fi
export ADDRESSES="$ROOT/contracts/deployments/10143-staging.json"
LOGS="${LOGS:-$ROOT/.logs}"; mkdir -p "$LOGS"
pids=(); trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/8}"
if [ -n "${DATABASE_URL:-}" ]; then
  node "$ROOT/services/indexer/dist/main.js" > "$LOGS/indexer.log" 2>&1 & pids+=($!)
  echo "indexer → $LOGS/indexer.log"
else
  echo "DATABASE_URL not set (put it in .env.db): indexer skipped"
fi
# One key per process: the pusher has its own relayer so its nonces never collide with admin or keeper txs.
# Testnet gas: push on a 45 s heartbeat (inside the 60 s ORACLE_FRESH_SEC) or immediately when orders are pending, not on every wiggle.
# P3: index-compute polls each Bloke's sources and publishes ticks; Blokes without a source on both
# legs follow the synthetic walk inside it (A16). SOURCE=synthetic restores the P1 behaviour.
INDEX_SOURCE="${INDEX_SOURCE:-compute}"
if [ "$INDEX_SOURCE" = compute ] && [ -n "${DATABASE_URL:-}" ]; then
  node "$ROOT/services/index-compute/dist/main.js" > "$LOGS/index-compute.log" 2>&1 & pids+=($!)
  echo "index-compute → $LOGS/index-compute.log"
else
  INDEX_SOURCE=synthetic
fi
SOURCE=$INDEX_SOURCE RELAYER_PRIVATE_KEY=$RELAYER_PRIVATE_KEY ORACLE_SIGNER_KEY=$ORACLE_SIGNER_PRIVATE_KEY BLOKE_IDS=1,2 \
  TICK_MS=300 MIN_CHANGE=1000000 HEARTBEAT_MS=45000 LOG_CHUNK=100 \
  node "$ROOT/services/oracle-pusher/dist/main.js" > "$LOGS/pusher.log" 2>&1 & pids+=($!)
KEEPER_PRIVATE_KEY=$KEEPER_PRIVATE_KEY SWEEP_MS=5000 STATE_DIR="$ROOT/.state" MIN_BALANCE_MON=0.2 \
  node "$ROOT/services/keeper/dist/main.js" > "$LOGS/keeper.log" 2>&1 & pids+=($!)
# API (stateless; run more replicas on other ports/hosts against the same Redis + Postgres).
# Without real GitHub app credentials, GitHub OAuth points at the integration suite's mock provider.
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/8}"
API_PORT="${API_PORT:-8080}"; MOCK_OAUTH_PORT="${MOCK_OAUTH_PORT:-18555}"
if [ -z "${GITHUB_CLIENT_ID:-}" ]; then
  export GITHUB_CLIENT_ID=it GITHUB_CLIENT_SECRET=it \
    GITHUB_TOKEN_URL="http://127.0.0.1:$MOCK_OAUTH_PORT/token" GITHUB_API_URL="http://127.0.0.1:$MOCK_OAUTH_PORT/api"
fi
# Staging: the deployer (LISTER) backs self-serve listings for "Start your raise" (A18).
export LISTER_PRIVATE_KEY="${LISTER_PRIVATE_KEY:-$DEPLOYER_PRIVATE_KEY}"
PORT=$API_PORT ALLOW_TEST_IDENTITY=1 RATE_LIMIT_PER_MIN=2000 DRIP_MON=0.25 \
  node "$ROOT/services/api/dist/main.js" > "$LOGS/api.log" 2>&1 & pids+=($!)
PORT=$((API_PORT + 1)) ALLOW_TEST_IDENTITY=1 RATE_LIMIT_PER_MIN=2000 DRIP_MON=0.25 \
  node "$ROOT/services/api/dist/main.js" > "$LOGS/api-b.log" 2>&1 & pids+=($!)
echo "pusher → $LOGS/pusher.log, keeper → $LOGS/keeper.log, api → :$API_PORT and :$((API_PORT + 1))"
wait
