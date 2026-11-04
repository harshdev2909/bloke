import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { keccak256, toHex } from "viem";
import { z } from "zod";
import type { Address } from "@bloke/sdk";
import { requireSession, sessionView } from "./auth.js";
import type { Ctx } from "./context.js";
import { HttpError, badRequest, forbidden, hexToBuf } from "./http.js";

export type Provider = "github" | "x" | "test";

export interface ProviderProfile {
  provider: Provider;
  externalId: string; // stable numeric id, never the handle (PRD §4.4)
  handle: string | null;
  createdAt: Date;
  followers: number;
}

const DAY = 86_400_000;

/** Must match TestUSDC/attester conventions: keccak256("<provider>:<numeric id>"). */
export function identityHash(provider: Provider, externalId: string): `0x${string}` {
  return keccak256(toHex(`${provider}:${externalId}`));
}

/**
 * Amendment A8 sybil floor: only these identities can use the faucet and count as "identity-linked"
 * for the graduation trader check. GitHub ≥ 30 days; X ≥ 90 days with ≥ 10 followers.
 */
export function qualifies(p: ProviderProfile, now = Date.now()): boolean {
  const ageDays = (now - p.createdAt.getTime()) / DAY;
  if (p.provider === "x") return ageDays >= 90 && p.followers >= 10;
  return ageDays >= 30;
}

/** Links a provider account to the session wallet. One identity may link several wallets (counted once). */
export async function linkIdentity(ctx: Ctx, wallet: Address, p: ProviderProfile) {
  const hash = identityHash(p.provider, p.externalId);
  await ctx.db.query(
    `INSERT INTO identities (identity_hash, provider, external_id, account_created_at, followers, qualifies, wallets, handle)
     VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7::bytea],$8)
     ON CONFLICT (identity_hash) DO UPDATE SET
       followers = EXCLUDED.followers, qualifies = EXCLUDED.qualifies, handle = EXCLUDED.handle,
       wallets = CASE WHEN $7::bytea = ANY(identities.wallets) THEN identities.wallets ELSE identities.wallets || $7::bytea END`,
    [hexToBuf(hash), p.provider, p.externalId, p.createdAt, p.followers, qualifies(p), hexToBuf(wallet), p.handle],
  );
  return hash;
}

// ---------------------------------------------------------------- OAuth providers

interface PendingAuth {
  provider: "github" | "x";
  wallet: Address;
  redirectUri: string;
  verifier?: string; // X uses PKCE
}

const b64url = (b: Buffer) => b.toString("base64url");

export function registerIdentity(app: FastifyInstance, ctx: Ctx, fetchImpl: typeof fetch = fetch) {
  app.post("/v1/identity/:provider/start", async (req) => {
    const wallet = await requireSession(ctx, req);
    const { provider } = z.object({ provider: z.enum(["github", "x"]) }).parse(req.params);
    const { redirectUri } = z.object({ redirectUri: z.string().url() }).parse(req.body);
    const state = b64url(randomBytes(24));
    const pending: PendingAuth = { provider, wallet, redirectUri };
    let url: string;
    if (provider === "github") {
      if (!ctx.env.GITHUB_CLIENT_ID) throw new HttpError(503, "provider_disabled", "GitHub sign-in isn't configured.");
      const q = new URLSearchParams({ client_id: ctx.env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, state, scope: "read:user", allow_signup: "false" });
      url = `${ctx.env.GITHUB_AUTHORIZE_URL}?${q}`;
    } else {
      if (!ctx.env.X_CLIENT_ID) throw new HttpError(503, "provider_disabled", "X sign-in isn't configured.");
      pending.verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash("sha256").update(pending.verifier).digest());
      const q = new URLSearchParams({
        response_type: "code",
        client_id: ctx.env.X_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: "users.read tweet.read",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      url = `${ctx.env.X_AUTHORIZE_URL}?${q}`;
    }
    await ctx.redis.set(`oauth:${state}`, JSON.stringify(pending), "EX", 600);
    return { url, state };
  });

  app.post("/v1/identity/:provider/callback", async (req) => {
    const wallet = await requireSession(ctx, req);
    const { provider } = z.object({ provider: z.enum(["github", "x", "test"]) }).parse(req.params);

    let profile: ProviderProfile;
    if (provider === "test") {
      // Staging/local only: lets the integration suite link deterministic identities without OAuth.
      if (!ctx.env.ALLOW_TEST_IDENTITY) throw forbidden("provider_disabled", "The test provider is disabled here.");
      const b = z
        .object({ externalId: z.string().regex(/^[\w-]{1,64}$/), handle: z.string().max(64).optional(), createdAt: z.string(), followers: z.number().int().min(0) })
        .parse(req.body);
      profile = { provider, externalId: b.externalId, handle: b.handle ?? null, createdAt: new Date(b.createdAt), followers: b.followers };
    } else {
      const { code, state } = z.object({ code: z.string().min(1).max(512), state: z.string().min(1).max(128) }).parse(req.body);
      const raw = await ctx.redis.getdel(`oauth:${state}`);
      if (!raw) throw badRequest("bad_state", "Sign-in link expired. Start again.");
      const pending = JSON.parse(raw) as PendingAuth;
      if (pending.provider !== provider || pending.wallet !== wallet) throw badRequest("bad_state", "This sign-in belongs to another wallet.");
      profile = provider === "github" ? await githubProfile(ctx, fetchImpl, code, pending) : await xProfile(ctx, fetchImpl, code, pending);
    }
    await linkIdentity(ctx, wallet, profile);
    return { data: await sessionView(ctx, wallet) };
  });
}

/** Exchanges the code and reads the numeric user id. The access token is used once and never stored. */
async function githubProfile(ctx: Ctx, f: typeof fetch, code: string, p: PendingAuth): Promise<ProviderProfile> {
  const tok = await f(ctx.env.GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: ctx.env.GITHUB_CLIENT_ID, client_secret: ctx.env.GITHUB_CLIENT_SECRET, code, redirect_uri: p.redirectUri }),
  }).then((r) => r.json() as Promise<{ access_token?: string; error?: string }>);
  if (!tok.access_token) throw badRequest("oauth_failed", `GitHub sign-in failed: ${tok.error ?? "no token"}`);
  const u = await f(`${ctx.env.GITHUB_API_URL}/user`, {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "bloke-api" },
  }).then((r) => r.json() as Promise<{ id?: number; login?: string; created_at?: string; followers?: number }>);
  if (!u.id || !u.created_at) throw badRequest("oauth_failed", "GitHub didn't return a profile.");
  return { provider: "github", externalId: String(u.id), handle: u.login ?? null, createdAt: new Date(u.created_at), followers: u.followers ?? 0 };
}

async function xProfile(ctx: Ctx, f: typeof fetch, code: string, p: PendingAuth): Promise<ProviderProfile> {
  const basic = Buffer.from(`${ctx.env.X_CLIENT_ID}:${ctx.env.X_CLIENT_SECRET ?? ""}`).toString("base64");
  const tok = await f(ctx.env.X_TOKEN_URL, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: p.redirectUri, code_verifier: p.verifier ?? "" }),
  }).then((r) => r.json() as Promise<{ access_token?: string; error?: string }>);
  if (!tok.access_token) throw badRequest("oauth_failed", `X sign-in failed: ${tok.error ?? "no token"}`);
  const u = await f(`${ctx.env.X_API_URL}/users/me?user.fields=created_at,public_metrics`, {
    headers: { authorization: `Bearer ${tok.access_token}` },
  }).then((r) => r.json() as Promise<{ data?: { id: string; username: string; created_at: string; public_metrics?: { followers_count: number } } }>);
  if (!u.data?.id) throw badRequest("oauth_failed", "X didn't return a profile.");
  return {
    provider: "x",
    externalId: u.data.id,
    handle: u.data.username,
    createdAt: new Date(u.data.created_at),
    followers: u.data.public_metrics?.followers_count ?? 0,
  };
}
