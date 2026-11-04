import type { FastifyInstance } from "fastify";
import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { z } from "zod";
import { blokeDeskAbi, blokeTokenAbi, blokeV2PairAbi, graduationLauncherAbi, lpLockerAbi, merkleDistributorAbi, vestingStreamAbi } from "@bloke/shared";
import type { GraduationView, TokenClaim } from "@bloke/sdk";
import type { Ctx } from "../context.js";
import { badRequest, hexToBuf, meta, notFound } from "../http.js";
import { merkle } from "../graduation.js";

/** Graduated tokens, their pools and allocations, and each wallet's claims (PRD §10). */
export function registerGraduationReads(app: FastifyInstance, ctx: Ctx) {
  const ticker = z.string().max(10).transform((t) => t.toUpperCase());

  /** Every launched (graduated) token, newest first. */
  app.get("/v1/graduations", async () => {
    const rows = (await ctx.db.query<{ id: number; ticker: string; name: string; archetype: string | null }>(`SELECT id, ticker, name, archetype FROM blokes WHERE status = 'graduated' AND NOT hidden ORDER BY id DESC`)).rows;
    const data = [];
    for (const r of rows) {
      const g = await graduationView(ctx, r.id);
      if (g.graduated) data.push({ ...g, ticker: r.ticker, name: r.name, archetype: r.archetype });
    }
    return { data, meta: meta({ graduations: "on-chain" }) };
  });

  app.get("/v1/graduations/:ticker", async (req) => {
    const { ticker: t } = z.object({ ticker }).parse(req.params);
    const row = (await ctx.db.query<{ id: number }>(`SELECT id FROM blokes WHERE ticker = $1`, [t])).rows[0];
    if (!row) throw notFound(`Bloke ${t}`);
    return { data: await graduationView(ctx, row.id), meta: meta({ graduation: "on-chain", lists: "indexed" }) };
  });

  /** The full allocation list behind a root, for anyone to recompute it. */
  app.get("/v1/graduations/:ticker/lists/:kind", async (req) => {
    const { ticker: t, kind } = z.object({ ticker, kind: z.enum(["airdrop", "backer"]) }).parse(req.params);
    const g = await graduationView(ctx, await idOf(ctx, t));
    if (!g.graduated) throw notFound(`Graduation of ${t}`);
    const root = kind === "airdrop" ? g.airdrop!.root : g.backer!.root;
    const list = await listByRoot(ctx, root);
    if (!list) throw notFound(`List for root ${root}`);
    return { data: { kind, root, leaves: list }, meta: meta({ list: "indexed" }) };
  });

  /** Every airdrop, backer and vesting claim the wallet has on graduated tokens, with proofs. */
  app.get("/v1/wallets/:addr/claims", async (req) => {
    const { addr } = z.object({ addr: z.string() }).parse(req.params);
    if (!isAddress(addr)) throw badRequest("bad_address", "Not an address.");
    const wallet = getAddress(addr);
    const grads = await ctx.db.query<{ id: number; ticker: string }>(`SELECT id, ticker FROM blokes WHERE status = 'graduated' ORDER BY id`);
    const out: TokenClaim[] = [];
    for (const b of grads.rows) {
      const g = await graduationView(ctx, b.id);
      if (!g.graduated) continue;
      for (const kind of ["airdrop", "backer"] as const) {
        const d = g[kind]!;
        const leaves = await listByRoot(ctx, d.root);
        const mine = leaves?.find((l) => getAddress(l.account) === wallet);
        if (!leaves || !mine) continue;
        const proof = merkle(leaves.map((l) => ({ account: l.account as Address, amount: BigInt(l.amount) }))).proofs.get(wallet.toLowerCase()) ?? [];
        const claimed = await ctx.pub.readContract({ address: ctx.a.distributor!, abi: merkleDistributorAbi, functionName: "isClaimed", args: [BigInt(d.id), wallet] });
        out.push({ ticker: b.ticker, token: g.token!, kind, distributionId: d.id, amount: mine.amount, proof, claimed, deadline: d.deadline });
      }
      if (g.vesting && getAddress(g.vesting.beneficiary) === wallet) {
        out.push({ ticker: b.ticker, token: g.token!, kind: "vesting", distributionId: g.vesting.id, amount: g.vesting.claimable, proof: [], claimed: false, deadline: null });
      }
    }
    return { data: out, meta: meta({ claims: "on-chain", proofs: "indexed" }) };
  });
}

async function idOf(ctx: Ctx, ticker: string): Promise<number> {
  const row = (await ctx.db.query<{ id: number }>(`SELECT id FROM blokes WHERE ticker = $1`, [ticker])).rows[0];
  if (!row) throw notFound(`Bloke ${ticker}`);
  return row.id;
}

async function listByRoot(ctx: Ctx, root: `0x${string}`): Promise<{ account: string; amount: string }[] | null> {
  const r = await ctx.db.query<{ leaves: { account: string; amount: string }[] }>(`SELECT leaves FROM graduation_lists WHERE root = $1 ORDER BY id DESC LIMIT 1`, [hexToBuf(root)]);
  return r.rows[0]?.leaves ?? null;
}

export async function graduationView(ctx: Ctx, blokeId: number): Promise<GraduationView> {
  const empty: GraduationView = { graduated: false, token: null, pair: null, at: null, symbol: null, price: null, reserves: null, lock: null, vesting: null, airdrop: null, backer: null, seed: null, predictedToken: null };
  if (!ctx.a.launcher) return empty;
  return ctx.cache.get(`grad:${blokeId}`, 10_000, async () => {
    const L = ctx.a.launcher!;
    const g = await ctx.pub.readContract({ address: L, abi: graduationLauncherAbi, functionName: "graduations", args: [blokeId] });
    const [token, pair, at, lockId, streamId, airdropId, backerId, seedUsdc, seedTbloke] = g;
    if (token === zeroAddress) {
      const predicted = await ctx.pub.readContract({ address: L, abi: graduationLauncherAbi, functionName: "predictToken", args: [blokeId] }).catch(() => null);
      return { ...empty, predictedToken: predicted };
    }
    const [symbol, reserves, token0, lock, stream, claimable, airdrop, backer, deskPrice] = await Promise.all([
      ctx.pub.readContract({ address: token, abi: blokeTokenAbi, functionName: "symbol" }),
      ctx.pub.readContract({ address: pair, abi: blokeV2PairAbi, functionName: "getReserves" }),
      ctx.pub.readContract({ address: pair, abi: blokeV2PairAbi, functionName: "token0" }),
      ctx.pub.readContract({ address: ctx.a.lpLocker!, abi: lpLockerAbi, functionName: "locks", args: [BigInt(lockId)] }),
      ctx.pub.readContract({ address: ctx.a.vesting!, abi: vestingStreamAbi, functionName: "streams", args: [BigInt(streamId)] }),
      ctx.pub.readContract({ address: ctx.a.vesting!, abi: vestingStreamAbi, functionName: "claimable", args: [BigInt(streamId)] }),
      ctx.pub.readContract({ address: ctx.a.distributor!, abi: merkleDistributorAbi, functionName: "distributions", args: [BigInt(airdropId)] }),
      ctx.pub.readContract({ address: ctx.a.distributor!, abi: merkleDistributorAbi, functionName: "distributions", args: [BigInt(backerId)] }),
      ctx.pub.readContract({ address: ctx.a.desk!, abi: blokeDeskAbi, functionName: "price" }),
    ]);
    const tokenIs0 = getAddress(token0) === getAddress(token);
    const rToken = tokenIs0 ? reserves[0] : reserves[1];
    const rTbloke = tokenIs0 ? reserves[1] : reserves[0];
    // Spot price in tBLOKE (18 dp) per token, and in tUSDC via the desk's fixed tBLOKE price.
    const inTbloke = rToken > 0n ? (rTbloke * 10n ** 18n) / rToken : 0n;
    const inUsdc = (inTbloke * deskPrice) / 10n ** 18n; // 6 dp
    const dist = (id: number, d: readonly [Address, `0x${string}`, bigint, boolean, Address, bigint, bigint]) => ({
      id,
      root: d[1],
      deadline: new Date(Number(d[2]) * 1000).toISOString(),
      total: d[5].toString(),
      claimed: d[6].toString(),
    });
    return {
      graduated: true,
      token,
      pair,
      symbol,
      at: new Date(Number(at) * 1000).toISOString(),
      price: { tbloke: inTbloke.toString(), usdc: inUsdc.toString(), deskUsdcPerTbloke: deskPrice.toString() },
      reserves: { token: rToken.toString(), tbloke: rTbloke.toString() },
      lock: { id: Number(lockId), amount: lock[4].toString(), unlockAt: new Date(Number(lock[1]) * 1000).toISOString(), personBps: lock[2], released: lock[3] },
      vesting: {
        id: Number(streamId),
        beneficiary: stream[1],
        total: stream[5].toString(),
        claimed: stream[6].toString(),
        claimable: claimable.toString(),
        cliffEnds: new Date((Number(stream[2]) + Number(stream[3])) * 1000).toISOString(),
        ends: new Date((Number(stream[2]) + Number(stream[3]) + Number(stream[4])) * 1000).toISOString(),
      },
      airdrop: dist(Number(airdropId), airdrop),
      backer: dist(Number(backerId), backer),
      seed: { usdc: seedUsdc.toString(), tbloke: seedTbloke.toString() },
      predictedToken: token,
    };
  });
}

