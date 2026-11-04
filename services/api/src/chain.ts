import { type Address, toHex } from "viem";
import { blokeRegistryAbi, humanIndexOracleAbi, marketEngineAbi, protocolConfigAbi } from "@bloke/shared";
import { MarketStatus } from "@bloke/chain-state";
import type { IndexValues, Leg, MarketSummary } from "@bloke/sdk";
import type { Ctx } from "./context.js";

export const LEGS: Leg[] = ["blend", "hype", "work"];
export const configKey = (k: string) => toHex(k, { size: 32 });
const WAD = 10n ** 18n;

/**
 * Reads go through `multicall` where the chain has Multicall3 (Monad) so a Bloke list is one RPC,
 * and are cached for 1 s per instance.
 */
async function readMany<T>(ctx: Ctx, calls: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }[]): Promise<T[]> {
  if (ctx.chain.contracts?.multicall3) {
    const r = await ctx.pub.multicall({ contracts: calls as never, allowFailure: false });
    return r as T[];
  }
  return Promise.all(calls.map((c) => ctx.pub.readContract(c as never) as Promise<T>));
}

export function oracleLatest(ctx: Ctx, ids: number[]): Promise<Map<number, IndexValues>> {
  return ctx.cache.get(`latest:${ids.join(",")}`, 1_000, async () => {
    const rows = await readMany<{ b: number; h: number; w: number; tsMs: bigint; lagFlags: number; fresh: boolean; tracked: boolean }>(
      ctx,
      ids.map((id) => ({ address: ctx.a.oracle, abi: humanIndexOracleAbi, functionName: "latest", args: [id] })),
    );
    return new Map(rows.map((r, i) => [ids[i]!, { b: r.b, h: r.h, w: r.w, tsMs: r.tsMs.toString(), fresh: r.fresh, lagFlags: r.lagFlags }]));
  });
}

export function marketIds(blokeId: number) {
  return LEGS.map((_, leg) => blokeId * 3 + leg);
}

export function markets(ctx: Ctx, blokeId: number): Promise<MarketSummary[]> {
  return ctx.cache.get(`markets:${blokeId}`, 1_000, async () => {
    const ids = marketIds(blokeId);
    const ms = await readMany<{
      status: number;
      net: bigint;
      grossCollateral: bigint;
      openLots: number;
    }>(ctx, ids.map((id) => ({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "market", args: [id] })));
    // quote(market, +1, 0) has zero impact: its mark is I·(1 + decayed premium).
    const qs = await readMany<readonly [bigint, bigint, bigint]>(
      ctx,
      ids.map((id) => ({ address: ctx.a.engine, abi: marketEngineAbi, functionName: "quote", args: [id, 1, 0n] })),
    );
    return ids.map((marketId, i) => {
      const m = ms[i]!;
      const [, premium, mark] = qs[i]!;
      const net = BigInt(m.net);
      return {
        marketId,
        leg: LEGS[i]!,
        status: MarketStatus[m.status] ?? "None",
        mark: mark.toString(),
        premium: premium.toString(),
        netUnits: net.toString(),
        netNotional: (((net < 0n ? -net : net) * mark) / WAD).toString(),
        grossCollateral: m.grossCollateral.toString(),
        openLots: Number(m.openLots),
      };
    });
  });
}

export function configValue(ctx: Ctx, key: string): Promise<bigint> {
  return ctx.cache.get(`cfg:${key}`, 30_000, () =>
    ctx.pub.readContract({ address: ctx.a.protocolConfig, abi: protocolConfigAbi, functionName: "get", args: [configKey(key)] }),
  );
}

export function registryBloke(ctx: Ctx, blokeId: number) {
  return ctx.cache.get(`regbloke:${blokeId}`, 2_000, () =>
    ctx.pub.readContract({ address: ctx.a.registry, abi: blokeRegistryAbi, functionName: "bloke", args: [blokeId] }),
  );
}

export function headBlock(ctx: Ctx): Promise<bigint> {
  return ctx.cache.get("head", 500, () => ctx.pub.getBlockNumber());
}
