#!/usr/bin/env bash
# Rebuilds a deployments JSON from Foundry's broadcast log: the addresses that actually landed on
# chain, not what a script run predicted. Usage: scripts/addresses-from-broadcast.sh <run.json> <out.json> [staging]
set -euo pipefail
run="$1"; out="$2"; staging="${3:-true}"
jq --argjson staging "$staging" '
  ([.transactions[] | select(.transactionType == "CREATE") | {(.contractName): .contractAddress}] | add) as $c
  | {
      chainId: (.chain),
      startBlock: ([.receipts[].blockNumber | tonumber? // (ltrimstr("0x") | explode | reduce .[] as $d (0; . * 16 + (if $d >= 97 then $d - 87 elif $d >= 65 then $d - 55 else $d - 48 end)))] | min),
      staging: $staging,
      accessManager: $c.AccessManager, protocolConfig: $c.ProtocolConfig, tusdc: $c.TestUSDC,
      oracle: $c.HumanIndexOracle, registry: $c.BlokeRegistry, pool: ($c.BlokePool // $c.SimplePool),
      engine: $c.MarketEngine, settler: $c.Settler
    }' "$run" > "$out"
cat "$out"
