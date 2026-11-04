# BLOKE API: frontend integration guide

The frontend talks to two things:

1. **`services/api`** (REST + WebSocket) for reads, sign-in, identity linking, attestations and the gasless faucet.
2. **The contracts, directly from the wallet** (wagmi/viem) for every trade, claim and verification. The API never holds user funds or signs user transactions.

Use **`@bloke/sdk`** for both. It has typed responses, the REST client, a reconnecting stream, ABIs, the chain config and error messages.

```ts
import { BlokeClient, BlokeStream, marketEngineAbi, monadTestnet, messageFor } from "@bloke/sdk";
const api = new BlokeClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
const stream = new BlokeStream({ url: process.env.NEXT_PUBLIC_API_URL!.replace(/^http/, "ws") + "/v1/stream" });
```

Contract addresses come from `contracts/deployments/10143-staging.json`, or from `GET /v1/status` → `data.addresses`.

## Conventions

- **Numbers.** tUSDC amounts are decimal strings in 6-decimal units (`"10000000000"` = 10,000 tUSDC). Prices are 18-decimal WAD strings. Index values are integers ×1e4 (`1000000` = 100.0).
- **Provenance.** Every read returns `meta.sources`, mapping each figure to `"on-chain" | "indexed" | "computed"`, for the PRD §14.6 tooltips.
- **Errors.** Errors are `{ error, message }` with an HTTP status. `message` is user-ready. Contract reverts are decoded client-side with viem; map the error name with `messageFor(name)`.
- **Limits.** 60 requests/min per IP and 10 attestations/hour per wallet, shared across all API instances.

## Onboarding flow (PRD F1, amendment A8)

```ts
// 1. Sign in (EIP-4361). The server builds the message; the wallet signs it.
const { message } = await api.siweMessage(address, monadTestnet.id);
await api.signIn(message, await signMessageAsync({ message }));  // sets an httpOnly cookie and remembers a bearer token

// 2. Link GitHub (or X). Redirect, then post the code back from your callback page.
const { url } = await api.identityStart("github", `${origin}/auth/github`);
location.href = url;
// …on /auth/github?code=…&state=…
await api.identityCallback("github", { code, state });

// 3. Gasless faucet: the API relays the mint and sends 0.5 MON once per identity,
//    so a brand-new wallet can trade without visiting the Monad faucet.
const { data } = await api.faucet();   // { txHash, amount, dripTxHash }
```

Identity rules: GitHub accounts must be at least 30 days old; X accounts at least 90 days with 10+ followers. Otherwise `403 identity_too_new`. Repeat claims within 24 h return `429 FaucetCooldown`.

## Trading (F2–F4): wallet → contracts

```ts
const fill = await api.bloke("FOUNDER");                    // markets[i].marketId, mark, premium, status
const quote = await readContract({ abi: marketEngineAbi, address: engine, functionName: "quote", args: [marketId, 1, collateral] });
// One transaction with an EIP-2612 permit (fallback: approve + requestOpen).
await writeContract({ abi: marketEngineAbi, address: engine, functionName: "requestOpenWithPermit",
  args: [marketId, side, collateral, slippageBps, 0n, permitDeadline, v, r, s], gas: estimate * 115n / 100n });
```

Monad bills the **gas limit**, so always pass `gas: estimate × 1.15` (`gasLimitFromEstimate`). Then follow the order on the stream:

```ts
stream.subscribe(`orders:${address.toLowerCase()}`, `index:FOUNDER`, "feed");
stream.on(({ channel, event }) => {
  if (event.type === "order" && event.status === "filled") { /* show the lot */ }
  if (event.type === "order" && event.status === "rejected") toast(messageFor(event.reason!));
});
```

Spread: `requestSpread(blokeId, ±1, collateral, slippageBps, 0)`. Close: `requestClose(lotId, slippageBps)`. Cancel is allowed 30 s after the request.

## Profile claim (F6) and source verification (F7)

```ts
const { data: c } = await api.claimAttestation("TICKER");   // the linked GitHub/X ids must match the listing
await writeContract({ abi: blokeRegistryAbi, address: registry, functionName: "claim", args: [c.blokeId, BigInt(c.nonce), BigInt(c.expiry), c.signature] });

const { message } = await api.sourcesMessage("TICKER");     // each deployer address signs this (EIP-191)
const { data: s } = await api.verifySources("TICKER", [{ address: deployer, signature }]);
await writeContract({ abi: blokeRegistryAbi, address: registry, functionName: "setSourceVerification",
  args: [s.blokeId, s.bitmap, s.linked, BigInt(s.nonce), BigInt(s.expiry), s.signature] });
```

Attestations expire after 5 minutes. Submit right away, or request a new one.

## Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/v1/blokes` | – | All Blokes: on-chain index, 1 h change, badge, status |
| GET | `/v1/blokes/:ticker` | – | Profile, sources, 3 markets (mark, premium, net OI), settle price, graduation checklist |
| GET | `/v1/blokes/:ticker/index?leg&range` | – | Chart series (`1h`→1 m, `24h`→5 m, `7d`/`30d`→1 h buckets) |
| GET | `/v1/blokes/:ticker/signals` | – | Per-source z, effective weight and degraded flag from index-compute; `meta.mode` is `signals` or `synthetic` (A16) |
| GET | `/v1/archetypes` | – | The six archetypes with sources, verification paths and how many Blokes each has |
| GET | `/v1/markets/:id/trades?limit` | – | Recent fills and closes |
| GET | `/v1/pool` | – | Floor (active/open series), Edge NAV and price per EDGE, Reserve, subordination, epoch clock, caps |
| GET | `/v1/epochs?limit` | – | Hourly waterfall settlements |
| GET | `/v1/graduations/:ticker` | – | Token, pair, spot price (tBLOKE and tUSDC), LP lock, vesting, airdrop/backer distributions; `predictedToken` before graduation |
| GET | `/v1/graduations/:ticker/lists/:kind` | – | The full `airdrop` or `backer` list behind the on-chain root |
| GET | `/v1/raises` | – | Open raises first, then recent closed ones (A18) |
| GET | `/v1/raises/:ticker?wallet` | – | A Bloke's latest raise with live raised/state from chain, and the wallet's commitment |
| GET | `/v1/wallets/:addr/claims` | – | Unclaimed airdrop/backer leaves with Merkle proofs, and vesting claimable |
| GET | `/v1/wallets/:addr` | – | Balances, claimable, open lots with live equity, closed history, orders, Rep, Edge/Floor positions, claimed profiles with Skin |
| GET | `/v1/rep?season&limit` | – | Leaderboard |
| GET | `/v1/status` | – | Oracle age per Bloke, indexer lag, addresses, `staging` flag |
| POST | `/v1/auth/nonce` | – | `{ nonce, message }` to sign |
| POST | `/v1/auth/siwe` | – | `{ token, session }` + cookie |
| GET | `/v1/auth/session` | session | Linked identities |
| POST | `/v1/auth/logout` | session | – |
| POST | `/v1/identity/:provider/start` | session | OAuth URL (`github`, `x`) |
| POST | `/v1/identity/:provider/callback` | session | Links the account (`github`, `x`; `test` on staging only) |
| POST | `/v1/faucet` | session | Relayed faucet mint + one-time MON drip |
| POST | `/v1/claims` | session | Claim attestation |
| POST | `/v1/sources/message` | session | Text for deployer signatures |
| POST | `/v1/sources/verify` | session | Source-verification attestation |
| POST | `/v1/suggestions` | session | Records a suggested Bloke (`first: true` if new) |
| POST | `/v1/reports` | optional | Abuse report or removal request |
| POST | `/v1/graduations/:ticker/attest` | session (claimed wallet) | Trader count + airdrop/backer roots, signed; `409 checks_failed` lists unmet checks. The wallet then calls `GraduationLauncher.graduate` |
| POST | `/v1/admin/blokes/:ticker/sources` | `x-admin-token` | Operator: register a listing's account ids (`x`, `reddit`, `search`, `hn`, `commits`, `releases`, `onchain`) |
| POST | `/v1/admin/blokes/:ticker/archetype` | `x-admin-token` | Operator: set or clear (`null`) the archetype |
| WS | `/v1/stream` | – | `{op:"subscribe", channels}`; channels `index:{TICKER}`, `orders:{wallet}`, `feed`, `status`, `blokes`, `epochs` |

## Scaling

The API is stateless:
- **State:** sessions, nonces, OAuth state, rate limits and locks live in Redis.
- **Live events:** the indexer publishes each committed batch to Redis, and every API instance relays it to its own sockets.
- **Faucet relay:** transactions are serialised across instances with a Redis lock, so replicas never collide on the relayer's nonce.

`docker compose up --scale api=N` runs N replicas. The integration suite checks that a session created on one instance works on another and that both receive the stream.

## Running it

```sh
scripts/e2e-local.sh                       # whole stack on Anvil + both integration suites (17 tests)
scripts/testnet-services.sh                # indexer, pusher, keeper, API against the testnet staging set
scripts/testnet-integration.sh             # both suites against testnet
```
