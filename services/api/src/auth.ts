import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAddress, isAddress } from "viem";
import { createSiweMessage, generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { z } from "zod";
import type { Address, Session } from "@bloke/sdk";
import type { Ctx } from "./context.js";
import { badRequest, bufToHex, hexToBuf, unauthorized } from "./http.js";

export const SESSION_COOKIE = "bloke_session";
const NONCE_TTL_SEC = 300;

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const sessionKey = (token: string) => `session:${sha(token)}`;

declare module "fastify" {
  interface FastifyRequest {
    wallet?: Address;
  }
}

/** Resolves the session from `Authorization: Bearer` or the httpOnly cookie. Sessions live in Redis. */
export async function resolveSession(ctx: Ctx, req: FastifyRequest): Promise<Address | undefined> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : req.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 128) return undefined;
  const addr = await ctx.redis.get(sessionKey(token));
  return addr ? (addr as Address) : undefined;
}

export async function requireSession(ctx: Ctx, req: FastifyRequest): Promise<Address> {
  const w = await resolveSession(ctx, req);
  if (!w) throw unauthorized();
  req.wallet = w;
  return w;
}

export async function sessionView(ctx: Ctx, wallet: Address): Promise<Session> {
  const r = await ctx.db.query<{ provider: "github" | "x" | "test"; external_id: string; handle: string | null; qualifies: boolean }>(
    `SELECT provider, external_id, handle, qualifies FROM identities WHERE $1 = ANY(wallets) ORDER BY provider`,
    [hexToBuf(wallet)],
  );
  return {
    address: wallet,
    identities: r.rows.map((x) => ({ provider: x.provider, externalId: x.external_id, handle: x.handle, qualifies: x.qualifies })),
  };
}

export function registerAuth(app: FastifyInstance, ctx: Ctx) {
  /** Step 1: the server builds the exact EIP-4361 message so domain, chain and nonce can't be forged. */
  app.post("/v1/auth/nonce", async (req) => {
    const body = z.object({ address: z.string(), chainId: z.number().int() }).parse(req.body);
    if (!isAddress(body.address)) throw badRequest("bad_address", "Not an address.");
    if (body.chainId !== ctx.a.chainId) throw badRequest("wrong_chain", `Switch to chain ${ctx.a.chainId}.`);
    const nonce = generateSiweNonce();
    const address = getAddress(body.address);
    await ctx.redis.set(`siwe:nonce:${nonce}`, address, "EX", NONCE_TTL_SEC);
    const now = new Date();
    const message = createSiweMessage({
      domain: ctx.env.SIWE_DOMAIN,
      uri: ctx.env.SIWE_URI,
      address,
      chainId: ctx.a.chainId,
      nonce,
      version: "1",
      statement: "Sign in to BLOKE. Testnet only: tUSDC has no value.",
      issuedAt: now,
      expirationTime: new Date(now.getTime() + NONCE_TTL_SEC * 1000),
    });
    return { nonce, message };
  });

  /** Step 2: verify (EOA or smart wallet via ERC-1271/6492), consume the nonce, start a session. */
  app.post("/v1/auth/siwe", async (req, reply) => {
    const body = z.object({ message: z.string().max(4000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }).parse(req.body);
    const msg = parseSiweMessage(body.message);
    if (!msg.address || !msg.nonce) throw badRequest("bad_message", "Malformed SIWE message.");
    const expected = await ctx.redis.getdel(`siwe:nonce:${msg.nonce}`);
    if (!expected || expected !== getAddress(msg.address)) throw unauthorized("Nonce expired or already used.");
    const fieldsOk = validateSiweMessage({ message: msg, domain: ctx.env.SIWE_DOMAIN, address: getAddress(msg.address), nonce: msg.nonce });
    if (!fieldsOk || msg.chainId !== ctx.a.chainId) throw unauthorized("Message doesn't match this site or chain.");
    const valid = await ctx.pub.verifySiweMessage({ message: body.message, signature: body.signature as `0x${string}` });
    if (!valid) throw unauthorized("Signature doesn't match.");

    const token = randomBytes(32).toString("hex");
    const wallet = getAddress(msg.address);
    await ctx.redis.set(sessionKey(token), wallet, "EX", ctx.env.SESSION_TTL_SEC);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.env.COOKIE_SECURE,
      path: "/",
      maxAge: ctx.env.SESSION_TTL_SEC,
    });
    return { token, session: await sessionView(ctx, wallet) };
  });

  app.get("/v1/auth/session", async (req) => {
    const wallet = await requireSession(ctx, req);
    return { data: await sessionView(ctx, wallet) };
  });

  app.post("/v1/auth/logout", async (req, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : req.cookies?.[SESSION_COOKIE];
    if (token) await ctx.redis.del(sessionKey(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

export { bufToHex };
