import { type Address, encodeAbiParameters, getAddress, keccak256 } from "viem";
import { blokePoolAbi, graduationLauncherAbi, poolShareAbi } from "@bloke/shared";
import type { Ctx } from "./context.js";
import { bufToHex } from "./http.js";

/**
 * Graduation inputs computed off-chain (PRD §10.1 check 6, §10.3): the identity-linked trader count,
 * the airdrop and backer allocations and their Merkle roots. The lists are stored and published so
 * anyone can recompute the roots.
 */

export const AIRDROP_TOTAL = 200_000_000n * 10n ** 18n;
export const BACKER_TOTAL = 100_000_000n * 10n ** 18n;
const WALLET_CAP = AIRDROP_TOTAL / 50n; // 2% of the airdrop (4M tokens)
const WINDOW_MS = 30 * 86_400_000;
const MAX_HOURS = 720;
const MIN_LOT_COLLATERAL = 50_000_000n; // 50 tUSDC
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- Merkle (OpenZeppelin-compatible)

export interface Leaf {
  account: Address;
  amount: bigint;
}

/** keccak256(bytes.concat(keccak256(abi.encode(account, amount)))), as MerkleDistributor.leaf. */
export function leafHash(l: Leaf): `0x${string}` {
  return keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [l.account, l.amount])));
}

const hashPair = (a: `0x${string}`, b: `0x${string}`) => keccak256((a < b ? a + b.slice(2) : b + a.slice(2)) as `0x${string}`);

/** Sorted-pair tree over sorted leaf hashes; an odd node is carried up unchanged. */
export function merkle(leaves: readonly Leaf[]): { root: `0x${string}`; proofs: Map<string, `0x${string}`[]> } {
  const hashes = leaves.map(leafHash);
  const order = hashes.map((h, i) => ({ h, i })).sort((x, y) => (x.h < y.h ? -1 : 1));
  let layer = order.map((o) => o.h);
  // position of each original leaf in the current layer
  let pos = new Map(order.map((o, k) => [o.i, k]));
  const proofs = new Map<string, `0x${string}`[]>(leaves.map((l) => [l.account.toLowerCase(), []]));
  if (!layer.length) return { root: `0x${"00".repeat(32)}`, proofs };
  while (layer.length > 1) {
    const next: `0x${string}`[] = [];
    for (let k = 0; k < layer.length; k += 2) next.push(k + 1 < layer.length ? hashPair(layer[k]!, layer[k + 1]!) : layer[k]!);
    leaves.forEach((l, i) => {
      const k = pos.get(i)!;
      const sib = k ^ 1;
      if (sib < layer.length) proofs.get(l.account.toLowerCase())!.push(layer[sib]!);
      pos.set(i, k >> 1);
    });
    layer = next;
  }
  return { root: layer[0]!, proofs };
}

// ---------------------------------------------------------------- allocation

/**
 * Splits `total` pro rata to weights with a per-wallet cap (water-filling: capped wallets drop out
 * and the rest is re-split). Whatever can't be placed (no qualifying wallets, everyone capped,
 * rounding dust) goes to `remainderTo`, so the leaves always sum to exactly `total`.
 */
export function allocate(weights: ReadonlyMap<string, bigint>, total: bigint, cap: bigint, remainderTo: Address): Leaf[] {
  const out = new Map<string, bigint>();
  let open = new Map([...weights].filter(([, w]) => w > 0n));
  let left = total;
  for (let round = 0; round < 64 && open.size && left > 0n; round++) {
    const sum = [...open.values()].reduce((a, b) => a + b, 0n);
    const capped: string[] = [];
    let placed = 0n;
    for (const [k, w] of open) {
      const room = cap - (out.get(k) ?? 0n);
      const share = (left * w) / sum;
      const give = share >= room ? room : share;
      if (share >= room) capped.push(k);
      out.set(k, (out.get(k) ?? 0n) + give);
      placed += give;
    }
    left -= placed;
    if (!capped.length) break;
    open = new Map([...open].filter(([k]) => !capped.includes(k)));
  }
  const r = remainderTo.toLowerCase();
  if (left > 0n) out.set(r, (out.get(r) ?? 0n) + left);
  return [...out].filter(([, v]) => v > 0n).map(([account, amount]) => ({ account: getAddress(account), amount }));
}

// ---------------------------------------------------------------- inputs from the indexer

/** Wallets that may not count for this Bloke: its linked wallets plus every wallet of the person's identities. */
async function excludedWallets(ctx: Ctx, blokeId: number, claimed: Address): Promise<Set<string>> {
  const r = await ctx.db.query<{ w: Buffer }>(
    `SELECT wallet AS w FROM linked_wallets WHERE bloke_id = $1
     UNION SELECT unnest(wallets) FROM identities WHERE $2 = ANY(wallets)`,
    [blokeId, Buffer.from(claimed.slice(2), "hex")],
  );
  return new Set([claimed.toLowerCase(), ...r.rows.map((x) => bufToHex(x.w)!.toLowerCase())]);
}

/** Check 6: distinct qualifying identities with at least one profitable closed lot on the Bloke. */
export async function traderCount(ctx: Ctx, blokeId: number, claimed: Address): Promise<number> {
  const excluded = [...(await excludedWallets(ctx, blokeId, claimed))].map((h) => Buffer.from(h.slice(2), "hex"));
  const r = await ctx.db.query<{ n: string }>(
    `SELECT count(DISTINCT i.identity_hash) AS n
       FROM identities i JOIN lots l ON l.owner = ANY(i.wallets) JOIN closes c ON c.lot_id = l.id
      WHERE i.qualifies AND l.market_id BETWEEN $1 AND $1 + 2
        AND c.price_pnl + c.funding_pnl - c.fee > 0
        AND NOT (l.owner = ANY($2::bytea[]))`,
    [blokeId * 3, excluded],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Airdrop weights (PRD §10.3): long lots on $NAME or $NAME.WORK held in the 30 days before now,
 * each ≥ 50 tUSDC and held ≥ 1 hour; weight = collateral × hours held (≤ 720). The earliness
 * multiplier from Rep is taken as 1× here (A17: per-lot multipliers aren't stored yet).
 */
export async function airdropWeights(ctx: Ctx, blokeId: number, claimed: Address, nowMs: number): Promise<Map<string, bigint>> {
  const excluded = await excludedWallets(ctx, blokeId, claimed);
  const r = await ctx.db.query<{ owner: Buffer; collateral: string; opened: Date; closed: Date | null }>(
    `SELECT l.owner, l.collateral::text, l.opened_at AS opened, c.closed_at AS closed
       FROM lots l LEFT JOIN closes c ON c.lot_id = l.id
      WHERE l.market_id IN ($1, $1 + 2) AND l.side = 1 AND l.collateral >= $2
        AND coalesce(c.closed_at, now()) >= to_timestamp($3 / 1000.0)`,
    [blokeId * 3, MIN_LOT_COLLATERAL.toString(), nowMs - WINDOW_MS],
  );
  const w = new Map<string, bigint>();
  for (const x of r.rows) {
    const owner = bufToHex(x.owner)!.toLowerCase();
    if (excluded.has(owner)) continue;
    const from = Math.max(x.opened.getTime(), nowMs - WINDOW_MS);
    const to = Math.min(x.closed?.getTime() ?? nowMs, nowMs);
    const hours = Math.min(MAX_HOURS, Math.floor((to - from) / HOUR_MS));
    if (hours < 1) continue;
    w.set(owner, (w.get(owner) ?? 0n) + BigInt(x.collateral) * BigInt(hours));
  }
  return w;
}

/**
 * Backer weights (PRD §10.3): Edge value × hours since the wallet's first deposit (≤ 720), commitments
 * to the person's successful raises × hours (A18), plus the person's Skin × hours since it reached
 * the minimum. Edge history is approximated by the current
 * balance (A17); the share-hour series needs per-epoch balances the indexer doesn't keep yet.
 */
export async function backerWeights(ctx: Ctx, blokeId: number, claimed: Address, nowMs: number): Promise<Map<string, bigint>> {
  const w = new Map<string, bigint>();
  const r = await ctx.db.query<{ wallet: Buffer }>(`SELECT DISTINCT wallet FROM deck_requests WHERE deck = 'edge' AND kind = 'deposit'`);
  const edgeToken = (await ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "edgeShares" })) as Address;
  for (const x of r.rows) {
    const wallet = bufToHex(x.wallet)! as Address;
    const shares = await ctx.pub.readContract({ address: edgeToken, abi: poolShareAbi, functionName: "balanceOf", args: [wallet] });
    if (shares === 0n) continue;
    const value = await ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "edgeValue", args: [shares] });
    const first = await ctx.db.query<{ t: Date | null }>(
      `SELECT min(e.settled_at) AS t FROM deck_requests d JOIN epochs e ON e.n = d.epoch WHERE d.wallet = $1 AND d.deck = 'edge' AND d.kind = 'deposit'`,
      [x.wallet],
    );
    const since = first.rows[0]?.t?.getTime() ?? nowMs - WINDOW_MS;
    const hours = BigInt(Math.max(1, Math.min(MAX_HOURS, Math.floor((nowMs - Math.max(since, nowMs - WINDOW_MS)) / HOUR_MS))));
    w.set(wallet.toLowerCase(), (w.get(wallet.toLowerCase()) ?? 0n) + value * hours);
  }
  // Raise backers (A18): commitments to a raise that reached its goal, × hours since committing.
  const raised = await ctx.db.query<{ wallet: Buffer; amount: string; at: Date }>(
    `SELECT e.wallet, e.amount::text, e.at FROM raise_events e JOIN raises r ON r.id = e.raise_id
      WHERE r.bloke_id = $1 AND r.state IN ('succeeded', 'withdrawn') AND e.kind = 'commit'`,
    [blokeId],
  );
  for (const x of raised.rows) {
    const k = bufToHex(x.wallet)!.toLowerCase();
    const hours = BigInt(Math.max(1, Math.min(MAX_HOURS, Math.floor((nowMs - Math.max(x.at.getTime(), nowMs - WINDOW_MS)) / HOUR_MS))));
    w.set(k, (w.get(k) ?? 0n) + BigInt(x.amount) * hours);
  }
  const [skin, skinSince] = await Promise.all([
    ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "skin", args: [blokeId] }),
    ctx.pub.readContract({ address: ctx.a.pool, abi: blokePoolAbi, functionName: "skinSince", args: [blokeId] }),
  ]);
  if (skin > 0n && skinSince > 0n) {
    const hours = BigInt(Math.max(1, Math.min(MAX_HOURS, Math.floor((nowMs - Number(skinSince) * 1000) / HOUR_MS))));
    const k = claimed.toLowerCase();
    w.set(k, (w.get(k) ?? 0n) + skin * hours);
  }
  return w;
}

export function capAirdrop(weights: ReadonlyMap<string, bigint>, treasury: Address): Leaf[] {
  return allocate(weights, AIRDROP_TOTAL, WALLET_CAP, treasury);
}

export function splitBackers(weights: ReadonlyMap<string, bigint>, treasury: Address): Leaf[] {
  return allocate(weights, BACKER_TOTAL, BACKER_TOTAL, treasury);
}

export function signGraduation(
  ctx: Ctx,
  m: { blokeId: number; traderCount: number; airdropRoot: `0x${string}`; airdropTotal: bigint; backerRoot: `0x${string}`; backerTotal: bigint; nonce: bigint; expiry: bigint },
) {
  return ctx.attester.signTypedData({
    domain: { name: "BLOKE Graduation", version: "1", chainId: ctx.a.chainId, verifyingContract: ctx.a.launcher! },
    types: {
      GradAttestation: [
        { name: "blokeId", type: "uint32" },
        { name: "traderCount", type: "uint32" },
        { name: "airdropRoot", type: "bytes32" },
        { name: "airdropTotal", type: "uint256" },
        { name: "backerRoot", type: "bytes32" },
        { name: "backerTotal", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "GradAttestation",
    message: m,
  });
}

/** On-chain checklist (PRD §10.1) with the off-chain trader count filled in. */
export async function launcherChecks(ctx: Ctx, blokeId: number, traders: number) {
  return ctx.pub.readContract({ address: ctx.a.launcher!, abi: graduationLauncherAbi, functionName: "checks", args: [blokeId, traders] });
}
