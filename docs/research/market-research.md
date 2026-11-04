# BLOKE — Market & Technical Research

_As of 2026-11-04. Sources are cited inline. **[UNVERIFIED]** marks claims I could not confirm from a primary source. **[LIVE-CHECKED]** marks facts I checked myself against Monad testnet RPC on 2026-11-04._

---

## 1. Competitive landscape

| Product | Mechanism | Traction (peak, then now) | What went right or wrong | Regulatory |
|---|---|---|---|---|
| **friend.tech** (Base, 2023–24) | Bonding-curve "keys" per X account, gating chat access | Peak of about $1.7M/day in fees and about 525k tx/day (Aug 2023). Activity fell more than 90% within days ([Cointelegraph](https://regional-front.cointelegraph.com/news/friendtech-pronounced-dead-inflows-activity-declines), [Forklog](https://forklog.com/en/community-notes-the-death-of-friend-tech/)). Contracts were handed to the null address in Sep 2024 ([Decrypt](https://decrypt.co/248576/friendtech-creators-bail-ethereum-social-platform?amp=1)). | Points farming plus reflexive curves produced a ponzi shape. Value depended on the creator showing up. The FRIEND token airdrop and the abandoned FriendChain marked the end ([The Defiant](https://thedefiant.io/news/defi/friend-tech-plummets-after-abandoning-friendchain)). | No SEC action seen. The main harm was to reputation. |
| **Zora creator / content coins** (Base) | Every post or creator becomes a coin on a Uniswap pool, with creator fees | Aug 2025 peak: more than 1.6M coins, about 3M traders, more than $470M volume. Protocol revenue fell from $5.64M (Q3'25) to about $107k (Q2'26). Base App dropped Creator Rewards and the social feed by Feb 2026. Zora shrank to fewer than 10 staff, and the CEO changed ([OneSafe/DefiLlama](https://www.onesafe.io/blog/zora-social-network-revenue-plunge), [The Defiant](https://thedefiant.io/news/defi/zora-co-founder-dee-goens-replaces-jacob-horne-as-ceo), [Yellow](https://yellow.com/news/creator-coin-experiment-faces-backlash-after-nick-shirley-token-crashes-66)) | Launches had no friction, but there was no reason to hold a coin after launch. A high-profile coin fell 66% in 2 days. | Unregistered-security questions were raised but no action was found. |
| **Time.fun** (Base, then Solana) | Tokens redeemable for minutes of a creator's time | More than $2M lifetime volume on Base before moving to Solana in Feb 2025 ([The Block](https://www.theblock.co/post/343031/tokenized-time-platform-time-fun-goes-live-on-solana-following-base-debut)). **[UNVERIFIED]** It reportedly closed its creator-token model and the domain no longer resolves (Aug 2026) ([Solana Compass](https://solanacompass.com/projects/timefun)). | Redemption utility was real but too small to support a market. | — |
| **Fantasy Top** (Blast, then Base) | Fantasy cards of CT personalities, scored on X engagement | Paid about $20M to players and "heroes". **Shut down on 2026-06-25.** Seed investors were refunded ([NFT News Today](https://nftnewstoday.com/2026/05/25/fantasytop-is-shutting-down-and-its-failure-says-a-lot-about-socialfi), [Crypto Briefing](https://cryptobriefing.com/fantasy-top-shut-down-socialfi/)) | Scoring on X engagement invited botting ([docs](https://fantasy-top.gitbook.io/fantasy-top-guide/learn-to-play-fantasy/core-concepts/scoring-and-social-signals)). Ran on a dying L2. Engagement decayed. | — |
| **Kaito** (Yaps, Attention Markets) | Mindshare index from X data. Yaps paid people to post. | **Yaps shut down in Jan 2026** after X revoked API access for apps that pay users to post (2026-01-15) ([Unchained](https://unchainedcrypto.com/x-bans-incentivized-posting-apps-prompting-shakeup-in-crypto-engagement-platforms/), [Whale Alert](https://whale-alert.io/stories/eb7aaf8a751c/Kaito-Shuts-Down-Yaps-After-X-Bans-Incentivized-Posts-Launches-Kaito-Studio)). **Attention Markets with Polymarket** launched Feb–Mar 2026. The pilot did more than $1.3M in volume ([The Defiant](https://thedefiant.io/news/defi/kaito-and-polymarket-unveil-attention-markets), [DeFi Rate](https://defirate.com/news/polymarket-kaito-roll-out-attention-markets-for-mindshare-trading-what-it-means/)). **[UNVERIFIED]** An April 2026 piece suggests a pivot or sunset ([BlockEden](https://blockeden.xyz/zh/blog/2026/04/29/kaito-yaps-sunset-attention-markets-pivot-infofi-platform-fragility/)). | The index product works. Anything that **depends on one platform's API** can be shut off overnight. Critics flag that the oracle is opaque and "recursive". | Runs on Polymarket's regulated rails. |
| **Noise** (MegaETH, then Base) | Perps on relative mindshare, up to 5x leverage | Beta had $112M of *simulated* volume from about 250 users. $7.1M seed led by Paradigm. Moved to Base in Jan 2026 ([MegaETH docs](https://megaeth-co.gitbook.io/mega-docs/megamafia/defi/noise), [crypto-fundraising](https://crypto-fundraising.info/blog/noise-raised-7-1m-in-a-seed-funding-round/), [HTX](https://www.htx.com/pt-pt/news/megaeth-loses-another-key-player-noise-shifts-to-base-after-NCK79qwS/)). **[UNVERIFIED]** whether Base mainnet is live. | **Closest analogue to BLOKE:** index-priced perps with no bonding curve. It covers projects and narratives, not individual builders. | — |
| **Talent Protocol** | Builder Score: a sum of credentials (GitHub, onchain, etc.), uncapped and "experimental" ([docs](https://docs.talentprotocol.com/docs/talent-passport/builder-score)) | No 2026 numbers found. | A data-only score with no market attached. **Potential data partner, or a source for the WORK leg.** | — |
| **Ethos** | Reviews, vouches (staked), and slashing feed a credibility score ([Decrypt](https://decrypt.co/309231/ethos-network-on-chain-reputation-trust)). An H2 2026 token filing exists ([Blockworks](https://blockworks.com/token-transparency/filing/ethos)). | No user numbers found. | Shows how to gate with reputation and fight sybils. Vouch rings are a known weakness. | — |
| **Pump.fun streamer coins** | Memecoin per streamer. Since Sep 2025, 50% of PumpSwap fees go to creators. | About $20M claimed by creators in one week. Top streamers earned about 19.6k SOL. About 24% of large coins went dormant within weeks ([Decrypt](https://decrypt.co/337872/pump-funs-new-fee-model-hands-out-2m-to-creators-in-first-24-hours), [Stepdata](https://stepdata.substack.com/p/pumpfun-livestream-tokens-hype-risk)) | Creator fees attract supply. The model rewards stunts, and coin value decays once streams stop. | "Unclear if under SEC authority" |
| **Bags** (Solana) | Launchpad where creators get royalties from trading volume | More than $1B volume. Creators claim more than $21M **[UNVERIFIED period]** ([DL News](https://www.dlnews.com/articles/defi/pump-fun-rival-bags-secures-1bn-user-trading-volume), [Solana Compass](https://solanacompass.com/projects/bags)) | Royalties attract creators who opt in to claim. | — |
| **Polymarket / Kalshi mention markets** | Binary contracts on whether a person says a word | Popular, but the CFTC charged a trader who bet on Trump-speech mentions after **reading the texts in advance**. Kalshi assisted ([Axios](https://www.axios.com/2026/06/10/cftc-prediction-markets-sports-event-contract-rules)). | Contracts about one person's own actions invite insider trading. | Proposed CFTC event-contract rule (Jun 2026), see §5. |
| **Human-capital ISAs** (Pando, Fantex) | Income pooling (Pando takes a 10% fee) or buying a share of future earnings (Fantex) ([SI](https://www.si.com/mlb/2018/11/21/mlb-prospects-salary-risk-pando-pooling), [Princeton thesis](https://dataspace.princeton.edu/handle/88435/dsp019w032612t)) | Pando is niche but alive. Fantex wound down (from memory, **[UNVERIFIED]**). | Real cash flows mean securities law applies and onboarding is slow. | Fantex was SEC-registered. ISAs face consumer-lending scrutiny. |

**Copy:**
- Noise and Kaito's **index-priced, no-curve** market.
- Bags and Pump's **creator-fee share** for profiles that claim, which brings supply in.
- Talent and Ethos's **multi-source, sybil-aware scoring**.
- Kaito and Polymarket's model of a **transparent, published index methodology**.

**Avoid:**
- friend.tech and Zora's reflexive bonding curves and points farming.
- Fantasy Top's **engagement-only scoring**, which bots can game.
- Any mechanism that **pays people to post**, which X bans and which kills API access.
- Single-person **event or word contracts**, which invite insider trading.
- Dependence on a single L2 or ecosystem.

---

## 2. Demand and positioning

**Wedge:** "Bloomberg terminal + perps for builder reputation." BLOKE prices the **work** people do (commits, releases, package downloads, onchain usage), not just their noise. Every SocialFi product above priced attention alone, and attention decays. A WORK leg grounded in GitHub, npm and onchain data is harder to fake, is mean-reverting, and is defensible.

**Segments:**
1. CT traders already trading mindshare (Kaito and Noise users).
2. VCs, scouts and grant committees who want a live signal on builders.
3. Builders themselves, who claim a profile to earn fees and get a graduation token.
4. Ecosystem teams (Monad, hackathons) running "builder leagues".

**Why 1x, index-priced, with no bonding curve is different:**
- Price comes from an oracle, not from flows, so there is no first-buyer advantage and no curve to dump on late buyers.
- Being short is possible. friend.tech, Zora and Pump are long-only, so bad news can't be priced.
- With 1x and no liquidations, the downside is bounded, which demos safely and is easier to frame legally.
- The LP tranche turns "the house" into a product. Floor holders earn a fixed rate and Edge holders take first loss for a higher return, much like GLP/HLP but tranched.

**Positioning advice for judges:**
- Lead with "**every social token died because it priced hype. BLOKE prices work.**" Show the HYPE/WORK split on screen.
- Show **manipulation resistance**: a sybil wave of X mentions moves the price at most N% because the WORK leg and caps anchor it.
- Show the **consent flow**: unclaimed profiles are "shadow" markets with conservative limits, and claimed profiles earn fees and can graduate. This defuses the right-of-publicity question before a judge raises it.
- Lean on Monad: about 300 ms blocks and sub-second finality enable 60 s oracle updates and cheap per-trade funding accounting. Use parallel execution as the demo hook.
- Show the LP risk dashboard live: Floor/Edge NAV, net open interest per person, and funding.

---

## 3. Data source feasibility and cost (late 2026)

**X API.** The free tier closed to new developers on 2026-02-06. Pay-per-use is now the default, and legacy Basic and Pro plans migrated in Jun and Sep 2026 ([MediaNama](https://www.medianama.com/2026/02/223-x-developer-api-pricing-pay-per-use-model/), [OpenTweet](https://opentweet.io/how-to/migrate-x-api-pro-to-pay-per-use)). Official pricing ([docs.x.com](https://docs.x.com/x-api/getting-started/pricing)):
- **$0.005 per post read** and **$0.010 per user lookup**.
- Cap of **3M post reads per month**, with Enterprise above that.
- The same resource is not re-billed within a 24h UTC window. X calls this a "soft" guarantee.
- $20 promo credit.
- Rate limits: `GET /2/tweets/search/recent` and `/2/users/:id/mentions` allow **450 requests per 15 min per app** ([rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)).

For 25 handles polled every 60 s, run one OR-query search with `since_id`. That is 1,440 requests a day, about 15 per 15 min, well within limits. If the OR-query is too long, run 2–3 batched queries, still fine. **[UNVERIFIED]** The query-length limit for pay-per-use was not confirmed.

**Cost scales with posts returned, not with polling frequency:**

| Average mentions per handle per day | Posts per month (×25) | Cost per month |
|---|---|---|
| 40 | 30k | **about $150** |
| 200 | 150k | **about $750** |
| 1,000 (one viral person) | 750k | **about $3,750** (still under the 3M cap) |

Mitigations:
- Use `tweets/counts/recent` for the HYPE volume signal and pull full posts only for a sample. **[UNVERIFIED]** The billing of the counts endpoint under pay-per-use was not confirmed.
- Cap the posts pulled per handle per minute.
- Never reward posting, which would violate the Jan 2026 InfoFi ban.

**Reddit.**
- Since 2025-11-11 under the **Responsible Builder Policy**, self-service API access is closed and every new app needs manual approval. Developers report fast rejections ([r/redditdev mirror](https://r.datuan.dev/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/noc31sg)).
- Free OAuth allows 100 QPM and is non-commercial only. Commercial use needs a contract. The often-quoted "$0.24 per 1k calls, $12k/yr minimum" dates from 2023 **[UNVERIFIED current]** ([SocialCrawl](https://www.socialcrawl.dev/blog/reddit-api-key-limits-alternatives-2026), [Octolens](https://octolens.com/blog/reddit-api-pricing)).
- **Recommendation:** apply now as non-commercial or research, use public `.json`/RSS sparingly as a fallback, and make Reddit **optional** in the index with weight 0 if unavailable.

**Google Trends.**
- The official **Trends API is still alpha and application-only**. Google announced it on 2025-07-24, there is no public pricing or GA, and it offers about 1,800 days of consistently scaled data ([Google Search Central](https://developers.google.com/search/blog/2025/07/trends-api?hl=it), [SE Roundtable](https://www.seroundtable.com/google-trends-api-applications-approvals-39978.html)).
- **pytrends is effectively dead** ([DEV](https://dev.to/esteban_ortega/pytrends-is-dead-heres-how-to-get-google-trends-data-in-2026-1a18)).
- SerpApi offers about 250 free searches a month, then $75/mo for 5k and $150/mo for 15k **[UNVERIFIED, from aggregators]** ([ScrapeGraph](https://scrapegraphai.com/blog/serpapi-pricing), [Costbench](https://costbench.com/software/web-scraping/serpapi/)).
- Trends is relative, allows 5 terms per comparison, and has hourly granularity at best, so **polling every 60 s is pointless**. Fetching 25 people (5 batches with one anchor term) hourly is about 3.6k calls a month, so **$75/mo**. Every 4h costs about 900 calls a month and fits a $25 tier.
- Apply for the alpha in parallel.

**GitHub GraphQL** ([docs](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)):
- 5,000 points/hr per user token. GitHub Apps get up to 12,500, or 10,000 on Enterprise Cloud.
- Secondary limits: 2,000 points/min and 100 concurrent requests.
- One aliased query for 25 users (`contributionsCollection`, latest releases, first:10) costs roughly 1–30 points. At 60 calls/hr that is at most about 1,800 points/hr. **Feasible on one free token.**
- Use REST events with ETag as a cheap change detector.

**Package registries:**
- **npm:** downloads API. The crawler policy asks for ≤1 req/s ([npm](https://docs.npmjs.com/policies/crawlers)), and the bulk endpoint takes up to 128 packages.
- **PyPI:** JSON API with no edge rate limit, but respect ETag and use RSS ([PyPI docs](https://docs.pypi.org/api/)). Download stats come from pypistats or BigQuery, not the JSON API.
- **crates.io:** 1 req/s with a contact User-Agent ([crates.io data access](https://crates.io/data-access)) **[UNVERIFIED this session]**.
- Download counts update daily, so poll hourly at most.

**Onchain usage:** your own indexer or Monad RPC (see §4 limits), or Envio/Goldsky. Free tiers fit an MVP.

**Recommended source plan (MVP, 25 people):**

| Source | Cadence | Monthly cost |
|---|---|---|
| X recent search, OR-batched with `since_id`, capped | 60 s | $150–750 (budget $300 with caps) |
| GitHub GraphQL | 60 s | $0 |
| npm, PyPI, crates.io | hourly | $0 |
| SerpApi Google Trends | hourly | $75 |
| Reddit | 15 min if approved, else off | $0 |
| Monad RPC / indexer | per block | $0 |
| **Total** | | **about $375–825/mo**, or about $100 if X is capped tightly during the hackathon |

---

## 4. Monad testnet facts check

| Item | Verified value | Source |
|---|---|---|
| Chain ID | **10143** (`eth_chainId` returns `0x279f`) | [testnets](https://docs.monad.xyz/developer-essentials/testnets) **[LIVE-CHECKED]** |
| RPCs | `testnet-rpc.monad.xyz` (QuickNode): **50 rps**, but **25 rps for `eth_call` and `estimateGas`**, batch 100, archive. `rpc.ankr.com/monad_testnet`: 300 req/10 s, no `debug_*`. `rpc-testnet.monadinfra.com`: **20 rps**, no batching, archive. All have WSS except Ankr. | same |
| Explorers | testnet.monadvision.com, testnet.monadscan.com. Faucet: faucet.monad.xyz | same |
| Block time | **300 ms** (cut from 400 ms in v0.15.0) | [MonadBFT](https://docs.monad.xyz/monad-arch/consensus/monad-bft), [releases](https://docs.monad.xyz/developer-essentials/changelog/releases.md) |
| Finality | Proposed, then **Voted** (speculative, 1 slot, about 300 ms), then **Finalized** (2 slots, about 600 ms), then **Verified** (state root, which trails by `execution_delay` blocks; the value is not stated) | [block states](https://docs.monad.xyz/monad-arch/consensus/block-states.md) |
| Gas billing | **You pay the gas *limit*, not gas used.** Set tight limits. Don't rely on `estimateGas` with large buffers. | [gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing.md) |
| Min base fee | **100 gwei** (observed `baseFeePerGas` = 100,000,000,000) | same **[LIVE-CHECKED]** |
| Per-tx gas limit | **30M**. Block limit is **150M** (cut from 200M), and there are at most 3,750 tx per block. | same, releases **[LIVE-CHECKED: block gasLimit 150M]** |
| Max contract size | **128 KB** runtime and 256 KB initcode | [differences](https://docs.monad.xyz/developer-essentials/differences) |
| Timestamp granularity | **Seconds**. Consecutive blocks share a timestamp: 3 sampled blocks returned `…931, …931, …932`. Never use `block.timestamp` deltas below 1 s, and expect several blocks per second. | **[LIVE-CHECKED]**, [SQD](https://sqd.dev/learn/monad-onchain-data/) |
| Other differences | No global mempool. Reserve-balance rule: a transaction can be included yet revert. Storage is paged with 128 slots per page. No blob transactions. P256 precompile at `0x0100`. EIP-7702 delegated EOAs keep a 10 MON minimum. | [differences](https://docs.monad.xyz/developer-essentials/differences) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | has code **[LIVE-CHECKED]** |
| Permit2 | `0x000000000022d473030f116ddee9f6b43ac78ba3` | has code **[LIVE-CHECKED]** |
| CreateX | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` | has code **[LIVE-CHECKED]** |
| Safe v1.4.1 | Safe `0x41675C09…461a`, SafeL2 `0x29fcB43b…C762`, ProxyFactory `0x4e1DCf7A…ec67` | has code **[LIVE-CHECKED: Safe]** |
| WMON | `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541` | has code **[LIVE-CHECKED]** |
| **USDC (testnet)** | `0x534b2f3A21130d7a60830c2Df862319e593943A3`. Symbol "USDC", 6 decimals. Listed in [token-list](https://github.com/monad-crypto/token-list). | has code **[LIVE-CHECKED]**. The minting or faucet path is **[UNVERIFIED]**. |
| **Uniswap V2/V3 (testnet)** | **Not deployed on the current testnet.** `@uniswap/sdk-core@7.20.0` still lists testnet V2 factory `0x733e88…59d0`, V2 router `0xfb8e1c…e436`, V3 factory `0x961235…4276`, SwapRouter02 and Universal Router `0x3ae6d8…893`, plus an old WMON `0x760AfE…5701`. **All return empty code.** They were wiped by the reset. | **[LIVE-CHECKED]** |
| Latest testnet reset | **2025-12-16** (v0.12.5, "reset from genesis"). No reset since. The current version is v0.16.5 (2026-10-15, `MONAD_TEN`). | [releases](https://docs.monad.xyz/developer-essentials/changelog/releases.md) |
| Foundry | **Upstream Foundry v1.8.0 or later is required**: "releases before v1.8 do not include Monad execution support". The **category-labs Monad fork is deprecated** and stops at MonadNine. Remove `foundryup --network monad`. Add `network = "monad"` to `foundry.toml`, with `hardfork` optional (defaults to MonadTen). **Local 1.5.1 must be upgraded** (`foundryup`). | [Foundry toolkit](https://docs.monad.xyz/tooling-and-infra/toolkits/foundry.md) |
| viem | `monadTestnet` ships in viem. **Recent builds set `blockTime: 300`**, and 2.48.8 still says 400. Multicall3 has `blockCreated` 251449. **[UNVERIFIED]** I could not confirm which version first added the chain. Pin a current 2.x and override `blockTime` if older. | [jsDelivr latest](https://cdn.jsdelivr.net/npm/viem@latest/chains/definitions/monadTestnet.ts), [2.48.8](https://cdn.jsdelivr.net/npm/viem@2.48.8/chains/definitions/monadTestnet.ts) |
| Mainnet | Live, **chain ID 143**, running v0.16.5 (2026-10-22). Uniswap V3 is in sdk-core for mainnet. Native USDC is `0x754704Bc…b603` via CCTP. Launched 2025-11-24 **[from memory, not verified here]**. | [network info](https://docs.monad.xyz/developer-essentials/network-information/index.md), [tokens](https://docs.monad.xyz/developer-essentials/network-information/tokens-and-bridges.md) |

---

## 5. Regulatory and policy risks (product takeaways, not legal advice)

- **Right of publicity and false endorsement.** Listing real, named people commercially without consent is the classic misappropriation fact pattern. Crypto precedents include Kanye West's cease-and-desist against Coinye and Lil Yachty's suit against an NFT company over his name and likeness ([Scarinci](https://scarincihollenbeck.com/law-firm-insights/kanye-west-lawsuit-shuts-down-digital-currency), [The Fashion Law](https://www.thefashionlaw.com/lil-yachty-is-suing-nft-co-over-unauthorized-use-of-his-name-likeness/)). Statutory damages are steepest in CA, NY and IL. Mitigations:
  - **Opt-in listings**, or an opt-out honored within 24h.
  - No photos or likeness for unclaimed profiles. Use the handle only.
  - A "not affiliated or endorsed" banner.
  - No graduation token without the person's signature.
- **CFTC perps.** The CFTC now treats perpetuals as futures. It approved Kalshi's BTC perp on 2026-05-29 and issued a policy statement inviting perps on *other asset classes* through Rule 40.3. Staff no-action relief followed on 2026-06-12 ([Dechert](https://www.dechert.com/knowledge/onpoint/2026/6/cftc-takes-historic-steps-to-bring-digital-asset-perpetual-contr.html), [Akin](https://www.akingump.com/en/insights/alerts/cftc-advances-framework-for-perpetual-contracts-and-247-markets)). That means **perps on a person index are swaps or futures that would need a DCM or an exemption if offered to US persons.** Testnet with no real value is fine. Any mainnet path needs geofencing and counsel.
- **Event contracts.** The CFTC's 2026-06-10 proposed rule allows most aggregate, objective-data contracts. It targets markets "vulnerable to manipulation", such as single plays or a specific player's actions and injuries ([Axios](https://www.axios.com/2026/06/10/cftc-prediction-markets-sports-event-contract-rules), [Freewritings](https://www.freewritings.law/2026/06/sports-speculation-and-the-public-interest-cftc-proposes-rules-specifying-when-event-contracts-are-contrary-to-the-public-interest/)). A **person index that the subject can move**, by tweeting or pushing commits, has the same flavor. The mention-market insider case shows that enforcement will happen.
- **SEC.** A graduated personal token that carries fee-share, buyback or promises from the person looks like an investment contract. Keep graduation tokens free of cash-flow rights in the MVP.
- **Platform policy.** X revoked API access for pay-to-post apps (Jan 2026). Never tie rewards to posting, or BLOKE loses the HYPE leg.

---

## 6. Recommended PRD changes

1. **Foundry:** require upstream Foundry **≥1.8.0**, upgrading from local 1.5.1, with `network = "monad"` in `foundry.toml`. Do **not** use the category-labs fork. Keep `evm_version = "prague"` and solc 0.8.28.
2. **Uniswap V2:** assume **no Uniswap on testnet**. Vendor and deploy BLOKE's own UniswapV2 factory and router (or a minimal constant-product pair) for graduation. Remove any hardcoded sdk-core testnet addresses.
3. **Collateral:** use testnet USDC `0x534b…43A3` (6 decimals) only if minting is confirmed. Otherwise deploy a `MockUSDC` with a faucet. Use WMON `0xFb8b…C541`.
4. **Gas:** set **explicit tight gas limits**, because you pay the limit. Keep per-tx gas under 30M. Size keeper batches (oracle updates for 25 people) accordingly.
5. **Time logic:** use second-granularity timestamps and **block-number-based** staleness checks. Oracle heartbeat should be at least 1 s (60 s is fine). Never assume 1 block equals 1 s.
6. **Keepers and frontend:** budget against **25 rps `eth_call`** on the public RPC. Use Multicall3 and WSS subscriptions, and keep Ankr as a fallback.
7. **Read confirmation:** read state at **Voted** for UX, but settle and liquidate only on **Finalized** blocks.
8. **Oracle cadence by source:** X and GitHub every 60 s, packages hourly, Trends hourly or every 4h, Reddit 15 min or optional. Persist the last-good value and decay the weight of stale legs.
9. **X budget:** use OR-batched recent search with `since_id`, a per-handle post cap, and a $300/mo hard spend cap. Evaluate the counts endpoint. Add a **"no rewards for posting"** policy.
10. **Reddit and Trends:** make both **optional legs** with weight 0 when unavailable. File the Reddit approval and the Google Trends alpha application now. Fall back to SerpApi at $75/mo.
11. **Consent model:** unclaimed people become "shadow markets" with low OI caps, handle-only display and a disclaimer, plus a 24h opt-out. Claimed profiles get a creator fee share (Bags/Pump-style) and graduation eligibility. Graduation tokens carry **no cash-flow rights**.
12. **Anti-manipulation:**
    - Cap per-interval index moves.
    - Weight WORK at 50% or more.
    - Filter HYPE through sybil and bot filters (account age, follower quality, optional Ethos/Talent scores).
    - Bar subjects and claimed wallets from trading their own market, or disclose it.
    - Add a mention-market-style insider rule.
13. **Publish the index methodology** and per-leg contributions on-chain or in IPFS each epoch. This answers the "opaque oracle" critique leveled at Kaito.
14. **LP risk:** add per-person and global net-OI caps relative to Edge NAV, plus funding that pushes toward balance. Show a live tranche dashboard in the demo.
15. **Compliance stance:** keep it testnet only and say so explicitly, with no real-value prizes tied to P&L. Note in the PRD that any mainnet launch needs a US geofence and CFTC/SEC review.
16. **Positioning copy:** "Social tokens priced hype and died. BLOKE prices work." Include the competitor graveyard (friend.tech, Fantasy Top, Zora, Yaps) as a slide.
