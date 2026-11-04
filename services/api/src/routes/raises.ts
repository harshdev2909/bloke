import type { FastifyInstance } from "fastify";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { blokeRaiseAbi } from "@bloke/shared";
import type { RaiseView } from "@bloke/sdk";
import type { Ctx } from "../context.js";
import { badRequest, bufToHex, meta } from "../http.js";

const STATES = ["none", "open", "succeeded", "failed", "cancelled", "withdrawn"] as const;

interface RaiseRow {
  id: string;
  bloke_id: number;
  ticker: string;
  name: string;
  archetype: string | null;
  person: Buffer;
  goal: string;
  min_commit: string;
  raised: string;
  opened_at: Date;
  deadline: Date;
  state: string;
  backers: string;
}

const SQL = `
  SELECT r.id::text, r.bloke_id, b.ticker, b.name, b.archetype, r.person, r.goal::text, r.min_commit::text, r.raised::text,
         r.opened_at, r.deadline, r.state,
         (SELECT count(DISTINCT e.wallet) FROM raise_events e WHERE e.raise_id = r.id AND e.kind = 'commit') AS backers
    FROM raises r JOIN blokes b ON b.id = r.bloke_id`;

function view(r: RaiseRow): RaiseView {
  // An open raise past its deadline failed (the contract reports it the same way).
  const state = r.state === "open" && r.deadline.getTime() < Date.now() ? "failed" : (r.state as RaiseView["state"]);
  return {
    id: Number(r.id),
    blokeId: r.bloke_id,
    ticker: r.ticker,
    name: r.name,
    archetype: r.archetype as RaiseView["archetype"],
    person: bufToHex(r.person)! as Address,
    goal: r.goal,
    minCommit: r.min_commit,
    raised: r.raised,
    backers: Number(r.backers),
    openedAt: r.opened_at.toISOString(),
    deadline: r.deadline.toISOString(),
    state,
    committed: null,
  };
}

/** Raises (amendment A18): open and recent raises, and one Bloke's latest with a wallet's commitment. */
export function registerRaiseReads(app: FastifyInstance, ctx: Ctx) {
  app.get("/v1/raises", async () => {
    const rows = await ctx.db.query<RaiseRow>(`${SQL} WHERE NOT b.hidden ORDER BY (r.state = 'open' AND r.deadline > now()) DESC, r.id DESC LIMIT 50`);
    return { data: rows.rows.map(view), meta: meta({ raises: "indexed" }) };
  });

  app.get("/v1/raises/:ticker", async (req) => {
    const { ticker } = z.object({ ticker: z.string().max(10).transform((t) => t.toUpperCase()) }).parse(req.params);
    const { wallet } = z.object({ wallet: z.string().optional() }).parse(req.query);
    if (wallet && !isAddress(wallet)) throw badRequest("bad_address", "Not an address.");
    const row = (await ctx.db.query<RaiseRow>(`${SQL} WHERE b.ticker = $1 ORDER BY r.id DESC LIMIT 1`, [ticker])).rows[0];
    if (!row) return { data: null, meta: meta({ raise: "indexed" }) };
    const v = view(row);
    if (ctx.a.raise) {
      // Chain state is authoritative for the live numbers; the index can trail by a block.
      const [info, mine] = await Promise.all([
        ctx.pub.readContract({ address: ctx.a.raise, abi: blokeRaiseAbi, functionName: "raiseInfo", args: [BigInt(v.id)] }),
        wallet ? ctx.pub.readContract({ address: ctx.a.raise, abi: blokeRaiseAbi, functionName: "committed", args: [BigInt(v.id), getAddress(wallet)] }) : null,
      ]);
      v.raised = info.raised.toString();
      v.state = STATES[info.state] as RaiseView["state"];
      v.committed = mine === null ? null : mine.toString();
    }
    return { data: v, meta: meta({ raise: "on-chain", backers: "indexed" }) };
  });
}
