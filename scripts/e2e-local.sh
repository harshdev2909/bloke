#!/usr/bin/env bash
# Full local loop: Anvil + staging deploy + indexer + oracle-pusher + keeper + integration suite.
# Requires: foundry, node 24, pnpm, a local Postgres (createdb/dropdb on PATH). Usage: scripts/e2e-local.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=${PORT:-8546}
RPC="http://127.0.0.1:$PORT"
DB=bloke_e2e_$$
LOGS="${LOGS:-$(mktemp -d)}"; mkdir -p "$LOGS"
# Anvil's well-known dev keys (never use outside a local chain)
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
SIGNER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
ATTESTER_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
RELAYER_PK=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
KEEPER_PK=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
FAUCET_RELAYER_PK=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
API_PORT=${API_PORT:-8090}
MOCK_OAUTH_PORT=${MOCK_OAUTH_PORT:-18555}
ADMIN_API_TOKEN=local-admin-token-$$-0000
export REDIS_URL=${REDIS_URL:-redis://127.0.0.1:6379/9}

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; dropdb --if-exists "$DB" 2>/dev/null || true; }
trap cleanup EXIT

echo "logs: $LOGS"
anvil --port "$PORT" --code-size-limit 131072 --silent > "$LOGS/anvil.log" 2>&1 & pids+=($!)
for i in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

cd "$ROOT/contracts"
PRIVATE_KEY=$DEPLOYER_PK ORACLE_SIGNER=$(cast wallet address $SIGNER_PK) ATTESTER=$(cast wallet address $ATTESTER_PK) \
  STAGING=true LIST_DEMO=true forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --disable-code-size-limit \
  > "$LOGS/deploy.log" 2>&1 || { tail -30 "$LOGS/deploy.log"; exit 1; }
ADDR="$ROOT/contracts/deployments/31337-staging.json"
echo "deployed: $(jq -c '{engine,oracle,registry}' "$ADDR")"

createdb "$DB"
export ADDRESSES="$ADDR" RPC_URL="$RPC" DATABASE_URL="postgres://localhost/$DB"
cd "$ROOT"
CONFIRMATION_TAG=latest node services/indexer/dist/main.js > "$LOGS/indexer.log" 2>&1 & pids+=($!)
RELAYER_PRIVATE_KEY=$RELAYER_PK ORACLE_SIGNER_KEY=$SIGNER_PK BLOKE_IDS=1,2 TICK_MS=400 \
  node services/oracle-pusher/dist/main.js > "$LOGS/pusher.log" 2>&1 & pids+=($!)
KEEPER_PRIVATE_KEY=$KEEPER_PK SWEEP_MS=2000 STATE_DIR="$LOGS/state" node services/keeper/dist/main.js > "$LOGS/keeper.log" 2>&1 & pids+=($!)
PORT=$API_PORT ATTESTER_PRIVATE_KEY=$ATTESTER_PK FAUCET_RELAYER_PRIVATE_KEY=$FAUCET_RELAYER_PK ALLOW_TEST_IDENTITY=1 \
  ADMIN_API_TOKEN=$ADMIN_API_TOKEN RATE_LIMIT_PER_MIN=2000 GITHUB_CLIENT_ID=it GITHUB_CLIENT_SECRET=it \
  GITHUB_TOKEN_URL=http://127.0.0.1:$MOCK_OAUTH_PORT/token GITHUB_API_URL=http://127.0.0.1:$MOCK_OAUTH_PORT/api \
  node services/api/dist/main.js > "$LOGS/api.log" 2>&1 & pids+=($!)
# Second instance on the same Redis/Postgres: proves the API is stateless (sessions + stream fan-out).
PORT=$((API_PORT + 1)) ATTESTER_PRIVATE_KEY=$ATTESTER_PK FAUCET_RELAYER_PRIVATE_KEY=$FAUCET_RELAYER_PK ALLOW_TEST_IDENTITY=1 \
  ADMIN_API_TOKEN=$ADMIN_API_TOKEN RATE_LIMIT_PER_MIN=2000 node services/api/dist/main.js > "$LOGS/api-b.log" 2>&1 & pids+=($!)
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$API_PORT/healthz" >/dev/null && curl -sf "http://127.0.0.1:$((API_PORT + 1))/healthz" >/dev/null && break; sleep 0.2; done

cd "$ROOT/tests/integration"
DEPLOYER_PRIVATE_KEY=$DEPLOYER_PK ATTESTER_PRIVATE_KEY=$ATTESTER_PK API_URL=http://127.0.0.1:$API_PORT API_URL_B=http://127.0.0.1:$((API_PORT + 1)) \
  ADMIN_API_TOKEN=$ADMIN_API_TOKEN MOCK_OAUTH_PORT=$MOCK_OAUTH_PORT pnpm -s integration && status=0 || status=$?
echo "--- pusher (last 3)"; tail -3 "$LOGS/pusher.log"
echo "--- keeper (last 3)"; tail -3 "$LOGS/keeper.log"
echo "--- indexer (last 3)"; tail -3 "$LOGS/indexer.log"
echo "--- api errors: $(grep -c '"level":50' "$LOGS/api.log" || true)"
exit $status
