import type { FastifyInstance, FastifyRequest } from "fastify";
import { type Address, getAddress, isHash, zeroAddress } from "viem";
import { z } from "zod";
import { blokeRegistryAbi } from "@bloke/shared";
import type { PowItem, PowView } from "@bloke/sdk";
import type { Ctx } from "../context.js";
import { requireSession } from "../auth.js";
import { badRequest, forbidden, hexToBuf, meta, notFound } from "../http.js";

/**
 * Proof of work, simulated (amendment A19). Items live off chain. A contract item is verified when
 * its deployment tx was sent by the person's claimed or linked wallet; a repo when its GitHub owner
 * is a GitHub login linked to the wallet; everything else is self-reported. The WORK effect shown
 * is a simulation: it does not feed the oracle.
 */
const KINDS = ["contract", "repo", "release", "paper", "product", "post"] as const;
const Body = z.object({
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(80),
  url: z.string().trim().url().max(200).refine((u) => /^https?:\/\//.test(u), "http(s) links only"),
  ref: z.string().trim().max(80).optional(),
});

interface Row {
  id: string;
  kind: PowItem["kind"];
  title: string;
  url: string;
  ref: string | null;
  status: PowItem["status"];
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

const toItem = (r: Row): PowItem => ({
  id: Number(r.id),
  kind: r.kind,
  title: r.title,
  url: r.url,
  ref: r.ref,
  status: r.status,
  note: r.note,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Simulated WORK points: what verified work would add to the WORK leg under A19's weights. */
export function simulatedBoost(items: readonly PowItem[]): number {
  const pts = items.reduce((s, i) => s + (i.status === "verified" ? 2 : i.status === "self_reported" ? 0.5 : 0), 0);
  return Math.min(20, Math.round(pts * 10) / 10);
}

async function blokeOf(ctx: Ctx, ticker: string) {
  const b = (await ctx.db.query<{ id: number; ticker: string }>(`SELECT id, ticker FROM blokes WHERE ticker = $1`, [ticker.toUpperCase()])).rows[0];
  if (!b) throw notFound(`Bloke ${ticker}`);
  return b;
}

async function requirePerson(ctx: Ctx, req: FastifyRequest, blokeId: number): Promise<Address> {
  const wallet = await requireSession(ctx, req);
  const claimed = await ctx.pub.readContract({ address: ctx.a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [blokeId] });
  if (claimed === zeroAddress || getAddress(claimed) !== getAddress(wallet)) throw forbidden("not_claimed_wallet", "Only the person who claimed this profile can edit its proof of work.");
  return wallet;
}

/** Decides the status of an item. Contract checks read the chain; repo checks read linked identities. */
async function verify(ctx: Ctx, blokeId: number, wallet: Address, b: z.infer<typeof Body>): Promise<{ status: PowItem["status"]; note: string | null }> {
  if (b.kind === "contract") {
    if (!b.ref || !isHash(b.ref)) return { status: "rejected", note: "Add the deployment transaction hash." };
    const [tx, rc] = await Promise.all([
      ctx.pub.getTransaction({ hash: b.ref as `0x${string}` }).catch(() => null),
      ctx.pub.getTransactionReceipt({ hash: b.ref as `0x${string}` }).catch(() => null),
    ]);
    if (!tx || !rc) return { status: "rejected", note: "That transaction isn't on Monad testnet." };
    if (!rc.contractAddress) return { status: "rejected", note: "That transaction didn't deploy a contract." };
    const from = getAddress(tx.from);
    const linked =
      from === getAddress(wallet) ||
      (await ctx.pub.readContract({ address: ctx.a.registry, abi: blokeRegistryAbi, functionName: "isLinked", args: [blokeId, from] }));
    return linked
      ? { status: "verified", note: `Deployed ${rc.contractAddress} from ${from.slice(0, 6)}…${from.slice(-4)}` }
      : { status: "rejected", note: "The deployer isn't your wallet or a verified deployer address." };
  }
  if (b.kind === "repo") {
    const owner = b.url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w-]+)\/[\w.-]+/i)?.[1]?.toLowerCase();
    if (!owner) return { status: "self_reported", note: "Not a GitHub repo link." };
    const r = await ctx.db.query<{ handle: string | null }>(`SELECT handle FROM identities WHERE provider = 'github' AND $1 = ANY(wallets)`, [hexToBuf(wallet)]);
    return r.rows.some((x) => x.handle?.toLowerCase() === owner)
      ? { status: "verified", note: `Owned by @${owner}, your linked GitHub` }
      : { status: "self_reported", note: "Link the GitHub account that owns it to verify." };
  }
  return { status: "self_reported", note: null };
}

export function registerPow(app: FastifyInstance, ctx: Ctx) {
  app.get("/v1/blokes/:ticker/pow", async (req) => {
    const { ticker } = z.object({ ticker: z.string().max(10) }).parse(req.params);
    const b = await blokeOf(ctx, ticker);
    const rows = await ctx.db.query<Row>(`SELECT * FROM pow_items WHERE bloke_id = $1 AND NOT retracted ORDER BY created_at DESC`, [b.id]);
    const items = rows.rows.map(toItem);
    const data: PowView = {
      items,
      verified: items.filter((i) => i.status === "verified").length,
      total: items.length,
      simulatedWorkBoost: simulatedBoost(items),
    };
    return { data, meta: { ...meta({ pow: "indexed" }), simulated: true } };
  });

  app.post("/v1/blokes/:ticker/pow", async (req) => {
    const { ticker } = z.object({ ticker: z.string().max(10) }).parse(req.params);
    const b = await blokeOf(ctx, ticker);
    const wallet = await requirePerson(ctx, req, b.id);
    const body = Body.parse(req.body);
    const live = await ctx.db.query(`SELECT 1 FROM pow_items WHERE bloke_id = $1 AND NOT retracted`, [b.id]);
    if ((live.rowCount ?? 0) >= 50) throw badRequest("too_many", "Up to 50 items per profile.");
    const v = await verify(ctx, b.id, wallet, body);
    const r = await ctx.db.query<Row>(
      `INSERT INTO pow_items (bloke_id, kind, title, url, ref, status, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.id, body.kind, body.title, body.url, body.ref ?? null, v.status, v.note],
    );
    return { data: toItem(r.rows[0]!) };
  });

  app.patch("/v1/pow/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().min(1) }).parse(req.params);
    const row = (await ctx.db.query<{ bloke_id: number }>(`SELECT bloke_id FROM pow_items WHERE id = $1 AND NOT retracted`, [id])).rows[0];
    if (!row) throw notFound("Item");
    const wallet = await requirePerson(ctx, req, row.bloke_id);
    const body = Body.parse(req.body);
    const v = await verify(ctx, row.bloke_id, wallet, body);
    const r = await ctx.db.query<Row>(
      `UPDATE pow_items SET kind = $2, title = $3, url = $4, ref = $5, status = $6, note = $7, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, body.kind, body.title, body.url, body.ref ?? null, v.status, v.note],
    );
    return { data: toItem(r.rows[0]!) };
  });

  app.delete("/v1/pow/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().min(1) }).parse(req.params);
    const row = (await ctx.db.query<{ bloke_id: number }>(`SELECT bloke_id FROM pow_items WHERE id = $1 AND NOT retracted`, [id])).rows[0];
    if (!row) throw notFound("Item");
    await requirePerson(ctx, req, row.bloke_id);
    await ctx.db.query(`UPDATE pow_items SET retracted = true, updated_at = now() WHERE id = $1`, [id]);
    return { data: { id, retracted: true } };
  });
}
