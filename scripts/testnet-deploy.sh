#!/usr/bin/env bash
# Deploys the STAGING contract set to Monad testnet (PRD §20.2 "contract set A") and funds the keeper.
# Keys come from .env.testnet (gitignored). The event set is deployed later with STAGING unset.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env.testnet"; set +a
forge --version | head -1 | grep -qE "1\.(8|9|[1-9][0-9])\." || { echo "Foundry >= 1.8 required for Monad"; exit 1; }

bal=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")
echo "deployer $DEPLOYER_ADDRESS balance: $(cast to-unit "$bal" ether) MON"
# Compare in milli-MON: wei amounts overflow bash's 64-bit integers.
mmon() { cast to-unit "$1" ether | awk '{printf "%d", $1 * 1000}'; }
[ "$(mmon "$bal")" -gt 3300 ] || { echo "need > 3.3 MON on the deployer (faucet.monad.xyz)"; exit 1; }

cd "$ROOT/contracts"
# Deployed contracts are still checked against Monad's 128 KB limit on chain.
PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY ORACLE_SIGNER=$ORACLE_SIGNER_ADDRESS ATTESTER=$ATTESTER_ADDRESS \
STAGING=true LIST_DEMO=true \
  forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --network monad --broadcast --slow --disable-code-size-limit
ADDR="$ROOT/contracts/deployments/10143-staging.json"
echo "addresses: $ADDR"; cat "$ADDR"; echo

# The keeper only pays gas; 1 MON covers a long test session.
kbal=$(cast balance "$KEEPER_ADDRESS" --rpc-url "$RPC_URL")
if [ "$(mmon "$kbal")" -lt 300 ]; then
  cast send "$KEEPER_ADDRESS" --value 1ether --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC_URL" >/dev/null
  echo "funded keeper with 1 MON"
fi
