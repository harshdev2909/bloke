# BLOKE

Test-money exchange on Monad testnet for going long or short a person, priced by a live Human Capital Index. Product spec: the BLOKE MVP PRD (v1.0, Nov 3 2026) plus [`docs/prd/amendments.md`](docs/prd/amendments.md) (v1.1). Market and platform research: [`docs/research/market-research.md`](docs/research/market-research.md).

## Layout

| Path | What |
|---|---|
| `contracts/` | Foundry 1.8.7. P0: `ProtocolConfig`, `TestUSDC`, `HumanIndexOracle`, `BlokeRegistry`. P1: `MarketEngine`, `Settler`, `SimplePool` (P2 replaces it with the waterfall pool). `script/Deploy.s.sol` deploys everything |
| `packages/index-core` | Pure index math (decay, baselines, z, squash, degraded sources), HYPE/WORK filters, Rep rules |
| `packages/shared` | Chain config, EIP-712 types, generated ABIs (`node scripts/gen-abi.mjs`) |
| `packages/chain-state` | Log reader and the engine-state reducer shared by pusher, keeper and indexer |
| `services/oracle-pusher` | Signs pushes and settles pending orders in the same tx via `Settler` (synthetic index until P3) |
| `services/keeper` | Expires, settles stragglers, exhausts, profit-caps, pokes funding, expires freezes, settles delists |
| `services/indexer` | Every event → Postgres, up to the Finalized block; runs migrations on start |
| `apps/web` | Next.js 16 frontend: Floor (3D orbit), Bloke page + ticket, Portfolio, Pool, Rep, Me (onboarding), Status. Uses `@bloke/sdk` |
| `packages/sdk` | Typed REST + WebSocket client, ABIs, chain config, error messages for the frontend |
| `services/api` | Stateless REST + WebSocket API (SIWE, OAuth, attestations, gasless faucet); see `docs/api.md` |
| `tests/integration` | The F1–F4 loop against a live deployment (local or testnet) |
| `db/migrations` | Postgres schema |

## Run locally

```sh
cd contracts && forge test                 # 68 tests incl. invariants
pnpm install && pnpm -r build && pnpm -r test
scripts/e2e-local.sh                       # Anvil + deploy + indexer + pusher + keeper + integration loop
```

## Frontend

```sh
cd apps/web && cp .env.local.example .env.local 2>/dev/null; pnpm dev   # http://localhost:3000, talks to NEXT_PUBLIC_API_URL
```

## Monad testnet (staging set)

```sh
# 1. fund the deployer in .env.testnet with ≥ 7 MON (faucet.monad.xyz); fund RELAYER_ADDRESS (pusher gas) too
# 2. optional: echo 'DATABASE_URL=postgres://…' > .env.db
scripts/testnet-deploy.sh                  # deploys STAGING set, writes contracts/deployments/10143-staging.json
scripts/testnet-services.sh                # indexer (if DATABASE_URL) + pusher + keeper
scripts/testnet-integration.sh             # in another terminal
```

Foundry ≥ 1.8 is required for Monad (`foundryup --install v1.8.7`). If a deploy runs out of gas midway, resume it with `forge script … --broadcast --resume`. Then rebuild the address file from what actually landed: `scripts/addresses-from-broadcast.sh contracts/broadcast/Deploy.s.sol/10143/run-latest.json contracts/deployments/10143-staging.json`.
