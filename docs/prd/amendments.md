# BLOKE MVP PRD: amendments v1.1

Nov 4, 2026. Applies to the BLOKE MVP PRD of Nov 3, 2026 (v1.0). Each amendment names the PRD section it changes, the problem, and the new rule. Where an amendment and v1.0 conflict, the amendment wins. Market and platform facts come from `docs/research/market-research.md`.

Status legend: **Built** = implemented in this repo with tests. **Spec** = rule fixed here, implementation lands in the named phase.

---

## A1. Oracle lag is no longer a free option (§4.2, §5.2, §7.1) · Built

**Problem.** The index is reproducible from public data, and the worker's ticks are streamed. When a raw value moves more than the 3% step clamp, the next several pushes are known in advance. Two-step settlement stops anyone trading on a push they've already seen. It doesn't stop trading on public inputs whose effect hasn't landed yet. Because pushes fire whenever orders are pending, a trader can even speed up the catch-up.

**Rule.**
1. The pusher always signs the **raw** worker value. The oracle applies range, band and step clamps as before.
2. For each Bloke and leg, the oracle stores a **lag flag**: `+1` if the range-clamped raw value is above the applied value, `−1` if below, `0` otherwise. The absolute range [0.5, 200] never sets a flag. `lagDirection(blokeId, leg)` exposes it.
3. At settlement, the engine computes the order's trade direction `d` (+1 for a long open or a short close, −1 for a short open or a long close). If `d × lag > 0`, the order profits from the known catch-up, and the engine then:
   - **rejects an open** with the new reason `Lagging` and a full refund, or
   - **defers a close** (it stays pending until the lag clears or the deadline passes).
   Orders against the lag fill normally.
4. The keeper sends catch-up pushes back to back while any lag flag is set, so a lag clears within about `ln(raw/applied)/ln(1.03)` pushes.
5. UI: the ticket shows "Index catching up ↑". The disabled side reads "Paused while the index catches up."

## A2. A graduation that can actually happen at the event (§1 Goals, §10.1, §18, §21) · Built (params), Spec (P4)

**Problem.** Event contracts deploy on day 12. `avg14` needs 14 days of oracle history and Skin needs 14 continuous days, so no graduation can happen in the event window. The trader check (100 profitable identity-linked wallets on one Bloke) is half the event's total target of 200. Holding a 14-day average of 120 against a baseline that keeps catching up with you is also unrealistic.

**Rule.**
1. The graduation windows and thresholds are now `ProtocolConfig` parameters with hard bounds: `GRAD_AVG_DAYS` 3–30, `GRAD_OI_DAYS` 1–30, `GRAD_SKIN_DAYS` 1–30, `GRAD_MIN_TRADERS` 10–100,000, `GRAD_MIN_HCS` 100–200 (all **Built**).
2. **Event profile** (set by the admin Safe before event go-live and shown on `/status`): average window 5 days, HCS ≥ 110, OI window 3 days at ≥ 10,000 tUSDC, 25 traders, Skin for 5 days. The **mainnet-intent profile** keeps the v1.0 values. The UI shows which profile is active.
3. **Deploy the oracle, registry and SkinVault first** (build day 5, not day 12) to the event contract set, so the launch list collects real history for 10+ days before the event.
4. Goal 1 is rewritten. A judge completes connect → faucet → trade → watch the index move → close → see the waterfall in under five minutes. They then open the founder's **already-graduated** token page and a second Bloke's live graduation checklist. Graduating is shown, not performed, by the judge.
5. The founder's profile is claimed and posts Skin on build day 5.

## A3. Caps sized for 200 traders (§6.4, §8.1, §18) · Built (params)

**Problem.** With E + R ≈ 100k, the per-market net cap was about 5,100 tUSDC. One max-size wallet filled a whole market's net side, so most opens at the event would be rejected `NetCap`.

**Rule.** tUSDC is valueless, so seed deeper and cap tighter as a fraction:
| | v1.0 | v1.1 |
|---|---|---|
| Seed Edge / Floor F-01 | 100k / 300k | **1,000,000 / 2,000,000** (Edge share 33%) |
| Net OI per market | 5% of E + R | **3%** (≈ 30k) |
| Net OI all markets (Σ\|net\|) | 60% | **30%** (≈ 300k) |
| Depth T1 / T2 / T3 | 60k / 30k / 15k | **300k / 150k / 75k** (impact stays ~1–2% per 5k order) |
| Minimum Edge before ReduceOnly | 20k | **100k** |

## A4. The event is a correlated HYPE shock (§6.4) · Built

**Problem.** During the event, mentions of all 12 opt-in Monad builders spike together against their 30-day baselines. `.HYPE` longs on every one of them win at once, so per-market caps don't limit the pool's correlated exposure.

**Rule.** A new **HYPE-family cap**: the *signed* sum of net OI across all `.HYPE` markets, |Σ net_hype|, must stay ≤ `NET_CAP_HYPE_FAMILY_BPS` (15%) of E + R. Fills that increase it are rejected `FamilyCap`. Orders that reduce it always fill. The `$NAME` blend carries 35% HYPE, so it counts at 0.35 weight toward the family sum.

## A5. A real bound on pool loss (§6.4, §16.1) · Built

**Problem.** The squash keeps the index inside about [3.6, 196.4], so the 0.5 floor never applies. A long opened near 3.6 can gain about 54×, and caps measured at open let positions grow past them as the price rises. "Bounded by net cap times remaining range" could exceed Edge.

**Rule.**
1. **Profit cap per lot:** gross profit ≤ `MAX_PROFIT_BPS` (200%) of collateral, so the payout is ≤ 3× collateral less the fee. Anyone may call `takeProfitCap(lotIds)` on lots at the cap. They close at mark with the normal fee, mirroring `exhaust`.
2. Invariant I4 becomes: `0 ≤ payout ≤ collateral + 0.97 × min(max(gross, 0), 2 × collateral)`.
3. The pool's worst case is then at most 2 × (30% global cap) = 60% of E + R, with Floor still junior-protected by the Reserve.

## A6. Rep can't be farmed with hedged pairs (§11.2) · Built (`packages/index-core/src/rep.ts`)

**Problem.** The daily-netting rule only removes the multiplier when the day's net is ≤ 0. A pair netting slightly positive still earns: +100 × 3 − 95 = 205 points from 5 tUSDC of PnL.

**Rule.** Per wallet, Bloke and UTC day: if the day's net is > 0, points = day net × b̄, where b̄ is the PnL-weighted mean earliness multiplier of that day's winning closes. The contrarian bonus is scaled by the contrarian share of winning PnL. Otherwise points = day net. A hedged pair earns at most (small net) × 3. Spreads are scored by the same rule.

## A7. Skin and self-dealing (§9.4, §7.2) · Built (self-trade ban), Spec (Skin lock, P2)

**Problems.**
- Skin absorbs only realised losses, so a Bloke can see large unrealised winning positions against the pool on their own markets and withdraw a day early.
- A Bloke controls their own WORK leg (they time their own releases) and could trade it from other wallets.

**Rules.**
1. **Skin lock:** a Skin withdrawal executes at the next epoch only for `Skin − max(0, −U_b)`, where `U_b` is the pool's unrealised result on that Bloke's three markets at execution. The rest stays locked until the exposure realises or reverses.
2. **No self-trading:** the engine reverts `SelfTrade` for any order from `registry.isLinked(blokeId, wallet)`. That covers the claimed wallet, a pending rotation wallet and verified deployer addresses (**Built**).
3. Off-chain, wallets linked to the Bloke's own GitHub/X identity are excluded from Rep, the trader count and the airdrop. A Bloke caught trading from unlinked wallets is flagged, which blocks graduation.
4. **Never reward posting.** X revoked API access for apps that pay users to post (Jan 2026; it ended Kaito Yaps). No Rep, airdrop or fee ever depends on posting about a Bloke.

## A8. A fresh wallet can finish the loop without MON (§2 F1, §12.2, §13.1) · Built (relayable faucet; drip exercised by the integration suite), Spec (drip service, P4 with the attester)

**Problem.** A brand-new embedded wallet has no MON, so it can't send the faucet transaction itself, and the public Monad faucet has its own gating. That threatens the 5-minute goal.

**Rules.**
1. `tUSDC.faucet(wallet, identityHash, expiry, sig)` takes the recipient explicitly. Anyone (our relayer) may submit it, and the attestation binds the wallet (**Built**).
2. The relayer drips **0.5 MON** to each new identity-linked wallet, once per identity, alongside the first faucet claim. The drip wallet alerts below 200 MON.
3. **Sybil floor:** the faucet attestation requires a GitHub account ≥ 30 days old or an X account ≥ 90 days old with ≥ 10 followers. Only such identities count as "identity-linked" for the graduation trader check.

## A9. Monad parallel execution: honest goal (§12 conventions) · Built

**Problem.** "No global counters on the hot path" is unreachable. Every fill writes the engine's tUSDC balance slot, and global caps need a global sum.

**Rule.** Replace the claim with:
- Per-market storage for order/lot sequence numbers (`id = marketId << 64 | n`) and for the epoch accumulators the pool reads at the crank. There is no pool write per fill. Cash moves at the crank.
- The global and HYPE-family net sums stay as the only global hot writes.
- Settlements are batched through `Settler`, so conflicts mostly fall inside one transaction anyway.

## A10. Smaller gaps

| # | Section | Change | Status |
|---|---|---|---|
| a | §5.2 | 24h band reference: the exact 24h-ago checkpoint, else the nearest newer one within 6 h, else (first day) the first-hour checkpoint, else no band. `goLive` requires a full day of checkpoints, so live markets always have a band. Hourly ring is 25 slots. | Built |
| b | §5.1 | Future tolerance `+3,000 ms` (was 2,000). Monad timestamps are whole seconds and consecutive blocks share them. Still bounded by `ORACLE_FUTURE_MS` 1–10 s. | Built |
| c | §6.5, §9, §17.2 | **Delisting:** a delist *request* snapshots the 60-minute TWAP and moves markets to ReduceOnly. Approval settles at that snapshot, and rejection restores Live. The settlement price can't be moved during the 48 h review. | Built |
| d | §8.4 | The Floor cap is **total**: Σ active series principal ≤ 4 × E. The next series' subscription window opens while the current one is active (F-02 opens at event start), with a cap of 4E − F_active at its start. | Spec (P2) |
| e | §5.5, §6.2 | Funding doesn't accrue for any touch interval that ends while the oracle is paused or the market is Frozen/SettleOnly. The interval between the last touch and the pause is also skipped; the 5-minute keeper poke bounds that loss. | Built |
| f | §12 | Contract size: Monad allows 128 KB. `MarketEngine` is 36.7 KB (via-IR). The gate is Monad's limit; Anvil runs with `--code-size-limit 131072`. Splitting below 24 KB is only needed for a non-Monad port. | Built |
| g | §13, §14.1, §20.1 | **Tooling:** Node 24 LTS (Node 20 is EOL), Next.js 16. Foundry pinned at **1.8.7**, which supports `--network monad`; note that `foundryup` without `--install` stayed on 1.5.1. Tests raise the per-test gas cap for the long handler run. Pin a current viem 2.x. | Built |
| h | §20.1 | **Canonical testnet contracts re-verified 2026-11-04:** Multicall3, Permit2 and CreateX as listed. Safe v1.4.1 is `0x41675C099F32341bf84BFc5382aF534df5C7461a`, which replaces the address in v1.0. **No Uniswap deployment survived the 2025-12-16 reset**, so we deploy our own V2 factory and router. A Circle testnet USDC exists (`0x534b…43A3`), but its mint path is unconfirmed; we keep our own tUSDC. | Spec |
| i | §13.1 | **RPC:** the public RPC caps `eth_call`/`estimateGas` at 25 rps. Services use a dedicated RPC and Multicall3 for reads, and the API caches chain reads per block. | Spec |
| j | §18 | Missing rows restored: index range [0.5, 200] (fixed constant), protocol fee 10% (0–20%), token split 50/20/15/10/5 (sum 100%). | Built |
| k | §16.1 I2 | Cash invariant includes `Σ claimable` (payout fallbacks and IOUs). | Spec (P2) |

## A13. A staging contract set that can trade in minutes (§20.2) · Built

**Problem.** The 24 h minimum shadow period and full-day history requirement mean a fresh testnet deployment can't trade for a day, so integration tests can't run after a deploy.

**Rule.** `ProtocolConfig` takes an immutable, public `staging` flag at construction. With `staging = true`, `SHADOW_SEC` is bounded 1 min–30 days and the new `MIN_HISTORY_HOURS` 0–168. With `false`, the v1.0 bounds hold (≥ 24 h shadow, ≥ 24 h history). The event contract set is deployed with `false`, and `/status` shows the flag so anyone can check.

## A14. Gas on Monad: cached parameters and packed state (§12, §19) · Built

**Problem.** Measured on testnet, a 2-Bloke heartbeat push cost ≈ 300k gas and an order fill 530k–1.03M. Monad bills the full gas limit and prices cold account and storage access well above Ethereum. Most of the cost came from one external `ProtocolConfig` call per parameter (≈ 7 per push, 10–15 per fill) and a 16-slot market struct.

**Rule.**
1. `ProtocolConfig` keeps a list of consumers and calls `syncParams()` on each in the same transaction as every `set`/`setAddress`. The oracle and engine keep packed local copies (2 and 3 slots). `syncParams()` is permissionless and idempotent, so the cached copies can never be stale.
2. The oracle drops its per-push cumulative slot. The settlement TWAP is now a one-minute-resolution average of per-minute samples (carry-forward for minutes without a push), written once a minute. `read()` returns value, freshness, lag and paused state in one call.
3. `MarketEngine.Market` is packed into 7 slots and `Lot` into 4, using SafeCast for the narrowed fields.

**Measured (Anvil pricing; Monad's savings are larger):** 25-entry push 806k → 520k; hour rollover 1.42M → 1.17M; single open fill 355k → 261k; close 260k → 187k. CI budgets in `OracleGas`/`EngineGas` fail on regression. Setup is costlier, since each `setAddress` re-syncs every consumer; admin changes are rare.

## A11. Data sources and budget (§4.1, §13.1) · Built (optional sources), Spec (ingest, P3)

From the research (late 2026):

| Source | Status | Plan | Est. cost / month |
|---|---|---|---|
| X | Pay-per-use only ($0.005 per post read; 3M reads/month cap); no free tier for new devs | One OR-batched recent search per 60 s with `since_id`; cost scales with mentions, not polling | ~$150 (40 mentions/handle/day) to ~$750 (200) |
| Reddit | Every new app needs manual approval (Responsible Builder Policy, since Nov 2025) | **Optional source**; apply now; if not approved, HYPE runs on X + Search with weights renormalised | $0 (non-commercial tier) |
| Google Trends | Official API is an invite-only alpha; pytrends no longer works | Apply for the alpha; fall back to SerpApi. **Poll hourly** (data is hourly at best) | ~$75 |
| GitHub | GraphQL 5,000 points/h | One aliased query for 25 users per 60 s ≈ 1,800 points/h, one token | $0 |
| npm / crates.io / PyPI | Public | ≤ 1 rps | $0 |

The index library supports disabled sources: their weight is renormalised across the leg, and a leg with a single enabled source stops when that source degrades (**Built**). Hackathon budget: ~$100–250/month with X reads capped. The paramsVersion hash covers which sources are enabled.

## A12. Positioning and policy (§1, §17) · Spec

- **Positioning:** every comparable product priced *hype*. friend.tech is abandoned, Fantasy Top shut down (Jun 2026), and Zora creator-coin revenue fell about 98% from Q3'25 to Q2'26. BLOKE prices *work* with an index, not a bonding curve. Lead every demo with `.WORK` and the Underrated spread.
- **Listing:** the event launches with **opt-in Blokes only** (founder + 12 opt-in Monad builders + up to 12 public builders who *confirm by DM before Shadow*). This resolves open question 4 and most right-of-publicity risk. Unclaimed profiles show handle and monogram only.
- **Graduation tokens** carry no cash-flow rights or revenue share, and graduation requires the person's own transaction.
- **Regulatory note for later:** the CFTC treats perps as futures (it approved a perp in May 2026). Its June 2026 proposed event-contract rule targets markets the subject can influence, which describes a person trading their own WORK leg. Testnet-only with valueless tokens stays the MVP boundary. A7's self-trade ban and flags are the product response.

## A15. The two-deck pool as built (§8) · Built

**Problem.** §8 describes the Floor/Edge waterfall but leaves three mechanics open: how a redemption bucket that can't be filled in full is handled, how many Floor series can run at once, and how Edge shares are denominated.

**Rule.**
1. **Partial redemptions are handed back.** Each epoch fills Edge redemptions only up to what keeps Edge ≥ 25% of Floor. The unfilled part of a bucket is returned to each requester as EDGE shares at `claimRedeem`, pro rata. It doesn't roll forward on its own; the holder re-requests. This keeps every bucket closed after one crank and removes cross-epoch queue state.
2. **One Floor series at a time.** One series is active, and the next can be subscribing while it runs. At maturity, the active series' value moves to escrow for `redeemFloor`, and the subscribing series starts at the next crank after its start time, filled up to 4× Edge. Overlapping ladders wait for mainnet economics (Q6).
3. **EDGE has 12 decimals.** Deposits mint shares at `(supply + 1e6) / (E + 1)`, the virtual-share guard against first-depositor inflation. That mints 1e6 share units per tUSDC unit, so EDGE uses 6 + 6 decimals and 1 EDGE ≈ 1 tUSDC at the start. Floor series tokens mint 1:1 and keep 6 decimals.
4. **Seeding goes through the real paths.** The deploy script deposits the Edge seed with `requestDeposit` + `crankEpoch` and subscribes the Floor seed to F-01. There's no privileged mint into the pool.

## A16. Real signals, per-Bloke source sets (§4, §13.2) · Built

**Problem.** P3 replaces the synthetic index with real signals, but three of the four HYPE sources need paid or approved access (X API, Reddit approval, Search/Trends), and most Blokes have accounts on only some sources. Under v1.0 a source a Bloke never reports is degraded, so two missing sources in a leg stop the Bloke forever.

**Rule.**
1. **index-compute** (`services/index-compute`) polls each Bloke's registered accounts, stores every event in `signal_events` (spam-filtered ones kept with `filtered_reason`), and publishes one tick per Bloke to the pusher through Redis (`index:ticks`). The pusher reads it with `SOURCE=compute`. A tick older than 90 s counts as stopped, so the oracle goes stale rather than repeating an old value.
2. **Hacker News** joins HYPE as a fourth source (weight 0.2; X 0.4, Reddit 0.2, Search 0.2), read through the public Algolia API with no key. The account id is a search phrase, and posts by the person's own HN handle are excluded.
3. **Per-Bloke source sets.** A source the Bloke has no account on, or that has no collector running (no API key), is disabled for that Bloke and the leg renormalises (`paramsForSources`). A Bloke needs at least one source on each leg to be priced from signals. Until then it follows the synthetic walk, now run inside index-compute.
4. **Published params document.** `paramsVersion` is the hash of `{params, blokes: {id: {mode, sources, weights}}}`, stored in `index_params`, so every push says which Blokes were on signals and with which weights.
5. **Cold start.** Until some Bloke has 3 days of history on a source (the launch cohort), a source with no history of its own is measured against zero activity, so it reads neutral (z = 0) while idle and positive as soon as something happens. A source with a little history stands on that history alone.
6. **Collectors as built:** GitHub commits and releases from the public events feed (backfills ≤ 90 days; ETags keep idle accounts free; own repos under 5 stars are filtered; 50 commits a day cap); on-chain activity as the account nonce (no backfill); Hacker News; X mention counts and Google Trends via SerpApi, which run only with `X_BEARER_TOKEN` / `SERPAPI_KEY` and haven't been run against the live APIs yet. Reddit stays off until approval.

## A17. Graduation as built (§10, §11.3) · Built

**Problem.** §10 assumes a Uniswap V2 deployment, contracts per graduation, and filled-in Rep and Edge history that the MVP doesn't keep yet.

**Rule.**
1. **AMM.** Monad testnet has no canonical V2 we can pin, so the project ships a 0.8.28 port (`BlokeV2Factory`, `BlokeV2Pair`, `BlokeV2Router`): same constant-product math, 0.3% fee, minimum-liquidity burn, TWAP accumulators and flash-swap callback; the fee switch is removed. The router covers the ERC-20 subset of Router02.
2. **Singletons.** `LPLocker`, `VestingStream` and `MerkleDistributor` are one contract each, holding every graduation's lock, stream and two distributions. A graduation deploys only its token (CREATE2, salt = blokeId) and its pair. Measured gas for `graduate` is about 3.3M (target < 8M).
3. **Pair check.** Nobody can seed reserves for a token that doesn't exist yet, so a pre-created pair at the predicted address is reused; tBLOKE donated to it ends up in the locked LP. `PairNotClean` stays as a defensive check.
4. **Token name.** The registry doesn't keep display names on chain, so tokens are named "BLOKE: $TICKER".
5. **Check 5 (OI).** `snapshotOi` (permissionless; the keeper calls it every 12 h) keeps 32 readings of the OI·time accumulator per Bloke; the check uses the newest reading at least `GRAD_OI_DAYS` old. `GRAD_MIN_OI_USDC = 0` passes the check outright.
6. **Allocations.** The airdrop's earliness multiplier is 1× until per-lot Rep multipliers are stored. Backer Edge weight uses the current EDGE value × hours since the first deposit, not a per-epoch share-hour series. Any part of the 200M/100M that can't be placed (the 2% wallet cap, no qualifying wallets, rounding) is a leaf for the treasury, so every root sums exactly to its allocation. Lists are stored in `graduation_lists` and served at `/v1/graduations/:ticker/lists/:kind`.
7. **Staging bounds.** On the staging set `GRAD_AVG_DAYS` may be 1, and `GRAD_MIN_TRADERS` and `GRAD_SKIN_DAYS` may be 0, so the whole path can run within a day of a deploy. The event set keeps the v1.0 bounds.
8. **Rep roots.** `RepRoots.post(season, root, uri)` (REP_PUBLISHER, once per season).

## A18. Raises (new, §9–§10) · Built

**Problem.** A person can only earn from BLOKE through creator fees and, much later, graduation. Backers who believe in someone early have no way to back them directly before a token exists.

**Rule.**
1. **`BlokeRaise`**: the claimed wallet of a Live or Shadow Bloke (not frozen, no abuse flag) opens one raise at a time: a goal of 1,000–1,000,000 tUSDC, open for 1 hour–30 days, with a minimum commitment of 1% of the goal (at most 10 tUSDC in the UI).
2. **All or nothing, hard cap.** Commitments stop at the goal; a commitment beyond the room left is clipped. The moment the goal is met, the raise succeeds and the person can withdraw. If the deadline passes first, or the person cancels, every backer refunds their own commitment.
3. **No self-dealing.** The person and every wallet linked to the Bloke (A7) can't commit.
4. **What backers get.** Nothing financial on chain: no cash-flow rights, no claim on fees (A12). A successful raise counts as backing at graduation: each commitment × hours since it was made (≤ 720) joins the 10% backer allocation weights.
5. **Start your raise (staging only).** `POST /v1/raises/start` lists the signed-in wallet with the staging LISTER key, binds a staging identity and the wallet's on-chain activity as its sources, and returns the claim attestation; the wallet then claims and opens its raise (two confirmations). On the event set, listing stays opt-in and operator-reviewed (A12).
6. **Hall of founders.** The Founder archetype shows historical founders (public-domain portraits, stippled). They are not Blokes and can't be traded; living people appear only by listing and claiming themselves (A12).
7. Indexed into `raises` and `raise_events`. Served at `/v1/raises` and `/v1/raises/:ticker?wallet=`; the live numbers come from chain.

## A19. Proof of work, simulated (§4, §9) · Built (simulation)

**Problem.** A person has no way to point at what they shipped beyond the sources the listing was built from.

**Rule.**
1. A claimed person adds, updates and retracts proof-of-work items: contract, repo, release, paper, product, post. Each has a title and a link, up to 50 per profile. They are stored off-chain (`pow_items`) for now, and a retracted item is kept.
2. **Verification.** A contract item is *verified* when its deployment tx (on Monad testnet) was sent by the claimed wallet or a verified deployer address. A GitHub repo is verified when its owner is a GitHub login linked to the wallet. Everything else is *self-reported*; a failed check reads *not verified* with the reason.
3. **Simulated effect.** The profile shows "+N WORK (simulated)": 2 points per verified item, 0.5 per self-reported item, capped at 20. It is not fed to the oracle. Wiring verified items into the WORK leg (as on-chain events or releases) is the follow-up, together with an on-chain anchor.

## Open questions after v1.1

Resolved: Q4 (opt-in only for the event). Partially resolved: Q2 (X via pay-per-use, ~$150–750/month; HYPE can launch on X + Search). Still open: Q1 submission date, Q3 embedded-wallet provider, Q5 escrow expiry, Q6–Q7 mainnet economics, Q8 the public-builder list.
