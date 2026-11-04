import type { FastifyInstance } from "fastify";
import { type Address, getAddress, isAddress, keccak256, parseEther, toHex, zeroAddress } from "viem";
import { z } from "zod";
import { ARCHETYPE_IDS, type ArchetypeId, blokeRegistryAbi, gasLimitFromEstimate, protocolConfigAbi, testUSDCAbi } from "@bloke/shared";
import { configKey } from "../chain.js";
import * as grad from "../graduation.js";
import { requireSession } from "../auth.js";
import { linkIdentity } from "../identity.js";
import {
  attestationBudget,
  expiryFromNow,
  randomNonce,
  signClaim,
  signFaucet,
  signSources,
  withRelayerLock,
} from "../attester.js";
import type { Ctx } from "../context.js";
import { HttpError, badRequest, conflict, forbidden, hexToBuf, notFound, tooMany } from "../http.js";

const ticker = z.string().regex(/^[A-Z0-9]{2,10}$/);

/** Source kinds proven by each identity provider (PRD §9.2). `test` stands in for GitHub on staging. */
const PROVIDER_KINDS: Record<string, string[]> = { github: ["commits", "releases"], test: ["commits", "releases"], x: ["x"] };

async function blokeByTicker(ctx: Ctx, t: string) {
  const r = await ctx.db.query<{ id: number; ticker: string }>(`SELECT id, ticker FROM blokes WHERE ticker = $1`, [t]);
  if (!r.rows[0]) throw notFound(`Bloke ${t}`);
  return r.rows[0];
}

async function walletIdentities(ctx: Ctx, wallet: Address) {
  return (
    await ctx.db.query<{ identity_hash: Buffer; provider: string; external_id: string; qualifies: boolean; faucet_last_at: Date | null; mon_dripped_at: Date | null }>(
      `SELECT identity_hash, provider, external_id, qualifies, faucet_last_at, mon_dripped_at FROM identities WHERE $1 = ANY(wallets)`,
      [hexToBuf(wallet)],
    )
  ).rows;
}

export function sourcesMessage(t: string, blokeId: number, wallet: Address) {
  return `BLOKE source verification\nBloke: ${t} (#${blokeId})\nClaimed wallet: ${wallet}\nI deployed contracts from this address and link it to this profile.`;
}

async function recordAttestation(ctx: Ctx, kind: string, wallet: Address, blokeId: number | null, nonce: bigint | null, expiry: bigint, payload: unknown) {
  await ctx.db.query(
    `INSERT INTO attestations (kind, wallet, bloke_id, nonce, expiry, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
    [kind, hexToBuf(wallet), blokeId, nonce?.toString() ?? null, new Date(Number(expiry) * 1000), JSON.stringify(payload, (_, v) => (typeof v === "bigint" ? v.toString() : v))],
  );
}

export function registerActions(app: FastifyInstance, ctx: Ctx) {
  /**
   * F1 / A8: gasless faucet. Signs the identity attestation and relays `faucet(wallet, …)` from the
   * relayer key, then drips MON once per identity so a brand-new wallet can trade immediately.
   */
  app.post("/v1/faucet", async (req) => {
    const wallet = await requireSession(ctx, req);
    const ids = await walletIdentities(ctx, wallet);
    if (!ids.length) throw forbidden("no_identity", "Connect GitHub or X first.");
    const id = ids.find((i) => i.qualifies);
    if (!id) throw forbidden("identity_too_new", "Your GitHub account must be 30+ days old, or your X account 90+ days with 10+ followers.");
    if (id.faucet_last_at && Date.now() - id.faucet_last_at.getTime() < 24 * 3600_000) {
      throw tooMany("FaucetCooldown", "This account already claimed in the last 24 hours.");
    }
    const identityHash = `0x${id.identity_hash.toString("hex")}` as `0x${string}`;
    const lockKey = `lock:faucet:${identityHash}`;
    if (!(await ctx.redis.set(lockKey, "1", "EX", 120, "NX"))) throw conflict("in_progress", "A faucet claim for this account is already running.");
    try {
      const expiry = expiryFromNow();
      const sig = await signFaucet(ctx, identityHash, wallet, expiry);
      const { txHash, dripTxHash } = await withRelayerLock(ctx, async () => {
        const call = { address: ctx.a.tusdc, abi: testUSDCAbi, functionName: "faucet", args: [wallet, identityHash, expiry, sig] } as const;
        let est: bigint;
        try {
          est = await ctx.pub.estimateContractGas({ ...call, account: ctx.relayer.account });
        } catch (err) {
          if (String(err).includes("FaucetCooldown")) throw tooMany("FaucetCooldown", "This account already claimed in the last 24 hours.");
          throw err;
        }
        const txHash = await ctx.relayer.writeContract({ ...call, gas: gasLimitFromEstimate(est) });
        const rc = await ctx.pub.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
        if (rc.status !== "success") throw new HttpError(502, "relay_failed", "The faucet transaction reverted.");
        let dripTxHash: `0x${string}` | null = null;
        const drip = parseEther(String(ctx.env.DRIP_MON));
        if (!id.mon_dripped_at && drip > 0n && (await ctx.pub.getBalance({ address: wallet })) < drip) {
          dripTxHash = await ctx.relayer.sendTransaction({ to: wallet, value: drip });
          await ctx.pub.waitForTransactionReceipt({ hash: dripTxHash, timeout: 30_000 });
        }
        return { txHash, dripTxHash };
      });
      await ctx.db.query(
        `UPDATE identities SET faucet_last_at = now(), mon_dripped_at = COALESCE(mon_dripped_at, CASE WHEN $2 THEN now() END) WHERE identity_hash = $1`,
        [id.identity_hash, dripTxHash !== null],
      );
      await ctx.db.query(`INSERT INTO faucet_relays (identity_hash, wallet, tx_hash, drip_tx_hash) VALUES ($1,$2,$3,$4)`, [
        id.identity_hash,
        hexToBuf(wallet),
        hexToBuf(txHash),
        dripTxHash ? hexToBuf(dripTxHash) : null,
      ]);
      await recordAttestation(ctx, "faucet", wallet, null, null, expiry, { identityHash, txHash });
      const amount = await ctx.cache.get("faucetAmount", 60_000, () =>
        ctx.pub.readContract({ address: ctx.a.protocolConfig, abi: protocolConfigAbi, functionName: "get", args: [configKey("FAUCET_AMOUNT_USDC")] }),
      );
      return { data: { txHash, amount, dripTxHash } };
    } finally {
      await ctx.redis.del(lockKey);
    }
  });

  /**
   * F6: claim attestation. Every account the listing was built from must be linked to this wallet,
   * matched on stable numeric ids (PRD §9.1). The wallet submits `claim()` itself.
   */
  app.post("/v1/claims", async (req) => {
    const wallet = await requireSession(ctx, req);
    const b = await blokeByTicker(ctx, ticker.parse((req.body as { ticker?: string })?.ticker));
    const claimed = await ctx.pub.readContract({ address: ctx.a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [b.id] });
    if (claimed !== zeroAddress) throw conflict("AlreadyClaimed", "This profile has already been claimed.");

    const sources = (
      await ctx.db.query<{ kind: string; external_id: string }>(`SELECT kind::text, external_id FROM bloke_sources WHERE bloke_id = $1 AND kind IN ('x','commits','releases')`, [b.id])
    ).rows;
    if (!sources.length) throw conflict("no_sources", "This listing has no identity sources to match yet.");
    const ids = await walletIdentities(ctx, wallet);
    const missing = sources.filter((s) => !ids.some((i) => PROVIDER_KINDS[i.provider]?.includes(s.kind) && i.external_id === s.external_id));
    if (missing.length) {
      throw forbidden("identity_mismatch", `Connect the ${[...new Set(missing.map((m) => (m.kind === "x" ? "X" : "GitHub")))].join(" and ")} account this profile was listed from.`);
    }
    if (!(await attestationBudget(ctx, wallet))) throw tooMany("attestation_limit", "Too many signature requests. Try again within the hour.");

    const nonce = randomNonce();
    const expiry = expiryFromNow();
    const signature = await signClaim(ctx, b.id, wallet, nonce, expiry);
    await recordAttestation(ctx, "claim", wallet, b.id, nonce, expiry, { signature });
    return { data: { blokeId: b.id, wallet, nonce: nonce.toString(), expiry: expiry.toString(), signature } };
  });

  /** F7: the text each deployer address signs (EIP-191). Binds the address to this Bloke and wallet. */
  app.post("/v1/sources/message", async (req) => {
    const wallet = await requireSession(ctx, req);
    const b = await blokeByTicker(ctx, ticker.parse((req.body as { ticker?: string })?.ticker));
    return { message: sourcesMessage(b.ticker, b.id, wallet) };
  });

  /** F7: verify deployer signatures and GitHub ownership, return the bitmap attestation. */
  app.post("/v1/sources/verify", async (req) => {
    const wallet = await requireSession(ctx, req);
    const body = z
      .object({ ticker, deployers: z.array(z.object({ address: z.string(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })).max(5) })
      .parse(req.body);
    const b = await blokeByTicker(ctx, body.ticker);
    const claimed = await ctx.pub.readContract({ address: ctx.a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [b.id] });
    if (claimed.toLowerCase() !== wallet.toLowerCase()) throw forbidden("NotClaimedWallet", "Only the claimed wallet can verify sources.");

    const message = sourcesMessage(b.ticker, b.id, wallet);
    const linked: Address[] = [];
    for (const d of body.deployers) {
      if (!isAddress(d.address)) throw badRequest("bad_address", `${d.address} is not an address.`);
      const ok = await ctx.pub.verifyMessage({ address: getAddress(d.address), message, signature: d.signature as `0x${string}` });
      if (!ok) throw badRequest("bad_signature", `The signature from ${d.address} doesn't match.`);
      if (!linked.some((l) => l.toLowerCase() === d.address.toLowerCase())) linked.push(getAddress(d.address));
    }
    const ids = await walletIdentities(ctx, wallet);
    const gh = (
      await ctx.db.query<{ external_id: string }>(`SELECT external_id FROM bloke_sources WHERE bloke_id = $1 AND kind IN ('commits','releases')`, [b.id])
    ).rows;
    const githubVerified = gh.length > 0 && gh.every((s) => ids.some((i) => PROVIDER_KINDS[i.provider]?.includes("commits") && i.external_id === s.external_id));
    // bit0 commits, bit1 releases (GitHub OAuth), bit2 on-chain usage (deployer signatures)
    const bitmap = (githubVerified ? 0b011 : 0) | (linked.length ? 0b100 : 0);
    if (bitmap === 0) throw conflict("nothing_verified", "Connect the listing's GitHub account or add a deployer address.");
    if (!(await attestationBudget(ctx, wallet))) throw tooMany("attestation_limit", "Too many signature requests. Try again within the hour.");

    const nonce = randomNonce();
    const expiry = expiryFromNow();
    const signature = await signSources(ctx, b.id, bitmap, linked, nonce, expiry);
    if (githubVerified) await ctx.db.query(`UPDATE bloke_sources SET verified = true, verified_at = now() WHERE bloke_id = $1 AND kind IN ('commits','releases')`, [b.id]);
    await recordAttestation(ctx, "sources", wallet, b.id, nonce, expiry, { bitmap, linked, signature });
    return { data: { blokeId: b.id, bitmap, linked, nonce: nonce.toString(), expiry: expiry.toString(), signature } };
  });

  /** F9: suggest a Bloke. The first wallet to suggest a handle is credited if it gets listed (Spotter). */
  app.post("/v1/suggestions", async (req) => {
    const wallet = await requireSession(ctx, req);
    const { handle } = z.object({ handle: z.string().min(2).max(64) }).parse(req.body);
    const norm = handle.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_.-]{2,64}$/.test(norm)) throw badRequest("bad_handle", "Use a GitHub or X handle.");
    const r = await ctx.db.query(`INSERT INTO suggestions (normalized_handle, first_wallet) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [norm, hexToBuf(wallet)]);
    return { data: { handle: norm, first: r.rowCount === 1 } };
  });

  /** F10 / §17.3: abuse reports and removal requests (triaged within 24 h / reviewed within 48 h). */
  app.post("/v1/reports", async (req) => {
    const wallet = await requireSession(ctx, req).catch(() => undefined);
    const body = z.object({ kind: z.enum(["abuse", "removal"]), ticker: ticker.optional(), body: z.string().min(1).max(4000) }).parse(req.body);
    const blokeId = body.ticker ? (await blokeByTicker(ctx, body.ticker)).id : null;
    const r = await ctx.db.query<{ id: string }>(`INSERT INTO reports (kind, bloke_id, wallet, body) VALUES ($1,$2,$3,$4) RETURNING id`, [
      body.kind,
      blokeId,
      wallet ? hexToBuf(wallet) : null,
      body.body,
    ]);
    return { data: { id: r.rows[0]!.id } };
  });

  /** P4 (graduation attester with airdrop/backer Merkle roots) is not built yet. */
  /**
   * Graduation attestation (PRD §10.2): the identity-linked trader count and the airdrop and backer
   * roots, signed for the claimed wallet, which then calls `graduate` itself. The lists behind both
   * roots are stored and served by GET /v1/graduations/:ticker/lists/:kind.
   */
  app.post("/v1/graduations/:ticker/attest", async (req) => {
    if (!ctx.a.launcher) throw new HttpError(501, "not_available", "This deployment has no graduation launcher.");
    const wallet = await requireSession(ctx, req);
    const { ticker: t } = z.object({ ticker }).parse(req.params);
    const b = await blokeByTicker(ctx, t);
    const claimed = await ctx.pub.readContract({ address: ctx.a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [b.id] });
    if (claimed === zeroAddress || getAddress(claimed) !== getAddress(wallet)) throw forbidden("not_claimed_wallet", "Only the wallet that claimed this profile can graduate it.");
    if (!(await attestationBudget(ctx, wallet))) throw tooMany("attestation_limit", "Too many signature requests. Try again within the hour.");

    const now = Date.now();
    const treasury = await ctx.pub.readContract({ address: ctx.a.protocolConfig, abi: protocolConfigAbi, functionName: "getAddress", args: [configKey("TREASURY")] });
    const [traders, aw, bw] = await Promise.all([
      grad.traderCount(ctx, b.id, claimed),
      grad.airdropWeights(ctx, b.id, claimed, now),
      grad.backerWeights(ctx, b.id, claimed, now),
    ]);
    const [pass] = await grad.launcherChecks(ctx, b.id, traders);
    const failed = pass.map((ok, i) => (ok ? null : i + 1)).filter((x): x is number => x !== null);
    // The checklist on GET /v1/blokes/:ticker shows each value; this only says which are missing.
    if (failed.length) throw conflict("checks_failed", `Not ready to graduate: check ${failed.join(", ")} not met.`);
    const airdrop = grad.capAirdrop(aw, treasury);
    const backers = grad.splitBackers(bw, treasury);
    const at = grad.merkle(airdrop);
    const bt = grad.merkle(backers);
    const nonce = randomNonce();
    const expiry = expiryFromNow();
    const message = { blokeId: b.id, traderCount: traders, airdropRoot: at.root, airdropTotal: grad.AIRDROP_TOTAL, backerRoot: bt.root, backerTotal: grad.BACKER_TOTAL, nonce, expiry };
    const signature = await grad.signGraduation(ctx, message);
    for (const [kind, root, leaves, total] of [
      ["airdrop", at.root, airdrop, grad.AIRDROP_TOTAL],
      ["backer", bt.root, backers, grad.BACKER_TOTAL],
    ] as const) {
      await ctx.db.query(
        `INSERT INTO graduation_lists (bloke_id, kind, root, total, leaves, trader_count, nonce) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [b.id, kind, hexToBuf(root), total.toString(), JSON.stringify(leaves.map((l) => ({ account: l.account, amount: l.amount.toString() }))), traders, nonce.toString()],
      );
    }
    await recordAttestation(ctx, "graduation", wallet, b.id, nonce, expiry, { signature, airdropRoot: at.root, backerRoot: bt.root, traders });
    return {
      data: {
        attestation: { ...message, airdropTotal: message.airdropTotal.toString(), backerTotal: message.backerTotal.toString(), nonce: nonce.toString(), expiry: expiry.toString() },
        signature,
        lists: { airdrop: { root: at.root, wallets: airdrop.length }, backer: { root: bt.root, wallets: backers.length } },
      },
    };
  });

  // ---------------------------------------------------------------- operator (admin token)

  /**
   * "Start your raise" (A18, staging only): lists the signed-in wallet as a Bloke, links a staging
   * identity to it as the listing's account, and returns the claim attestation. The wallet then
   * claims and opens its raise itself. On the event set listing stays operator-reviewed (A12).
   */
  app.post("/v1/raises/start", async (req) => {
    if (!ctx.lister || !ctx.env.ALLOW_TEST_IDENTITY) throw new HttpError(501, "not_available", "Self-serve listing is staging only. Ask to be listed.");
    const wallet = await requireSession(ctx, req);
    const body = z
      .object({
        ticker: z.string().regex(/^[A-Za-z0-9]{2,10}$/, "2–10 letters or digits").transform((t) => t.toUpperCase()),
        name: z.string().trim().min(2).max(40),
        archetype: z.enum(ARCHETYPE_IDS as [ArchetypeId, ...ArchetypeId[]]),
      })
      .parse(req.body);
    const taken = await ctx.db.query(`SELECT 1 FROM blokes WHERE ticker = $1`, [body.ticker]);
    if (taken.rowCount) throw conflict("ticker_taken", `$${body.ticker} is taken. Pick another ticker.`);
    const mine = await ctx.db.query(`SELECT 1 FROM blokes WHERE claimed_wallet = $1`, [hexToBuf(wallet)]);
    if (mine.rowCount) throw conflict("already_listed", "This wallet already has a profile.");
    if (!(await attestationBudget(ctx, wallet))) throw tooMany("attestation_limit", "Too many requests. Try again within the hour.");

    // List on chain as the staging lister.
    const call = {
      address: ctx.a.registry,
      abi: blokeRegistryAbi,
      functionName: "list",
      args: [{ ticker: toHex(body.ticker, { size: 16 }), name: body.name, sourceIdsHash: keccak256(toHex(`self:${wallet}`)), tier: 3, workSourceMask: 4 }],
    } as const;
    const est = await ctx.pub.estimateContractGas({ ...call, account: ctx.lister.account });
    const hash = await ctx.lister.writeContract({ ...call, gas: gasLimitFromEstimate(est) });
    const rc = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (rc.status !== "success") throw new HttpError(502, "list_failed", "Listing didn't go through. Try again.");

    // Wait for the indexer to see it (Finalized ≈ 1 s on Monad).
    let id: number | undefined;
    for (let i = 0; i < 40 && id === undefined; i++) {
      id = (await ctx.db.query<{ id: number }>(`SELECT id FROM blokes WHERE ticker = $1`, [body.ticker])).rows[0]?.id;
      if (id === undefined) await new Promise((r) => setTimeout(r, 500));
    }
    if (id === undefined) throw new HttpError(504, "index_lag", "Listed, but not indexed yet. Try again in a moment.");

    // The listing's account: a staging identity bound to this wallet, plus the wallet's on-chain activity.
    const identity = `self-${wallet.slice(2, 12).toLowerCase()}`;
    await linkIdentity(ctx, wallet, { provider: "test", externalId: identity, handle: body.name, createdAt: new Date("2020-01-01"), followers: 10 });
    await ctx.db.query(
      `INSERT INTO bloke_sources (bloke_id, kind, external_id, handle) VALUES ($1,'commits',$2,$3), ($1,'onchain',$4,NULL), ($1,'hn',$5,NULL)
       ON CONFLICT DO NOTHING`,
      [id, identity, body.name, wallet, body.name],
    );
    await ctx.db.query(`UPDATE blokes SET archetype = $2 WHERE id = $1`, [id, body.archetype]);

    const nonce = randomNonce();
    const expiry = expiryFromNow();
    const signature = await signClaim(ctx, id, wallet, nonce, expiry);
    await recordAttestation(ctx, "claim", wallet, id, nonce, expiry, { signature, selfServe: true });
    return { data: { blokeId: id, ticker: body.ticker, wallet, nonce: nonce.toString(), expiry: expiry.toString(), signature } };
  });

  /** Sets a Bloke's archetype (null clears it, so it is derived from the sources again). */
  app.post("/v1/admin/blokes/:ticker/archetype", async (req) => {
    const token = req.headers["x-admin-token"];
    if (!ctx.env.ADMIN_API_TOKEN || token !== ctx.env.ADMIN_API_TOKEN) throw forbidden("admin_only", "Admin token required.");
    const { ticker: t } = z.object({ ticker }).parse(req.params);
    const { archetype } = z.object({ archetype: z.enum(ARCHETYPE_IDS as [ArchetypeId, ...ArchetypeId[]]).nullable() }).parse(req.body);
    const b = await blokeByTicker(ctx, t);
    await ctx.db.query(`UPDATE blokes SET archetype = $2 WHERE id = $1`, [b.id, archetype]);
    return { data: { blokeId: b.id, archetype } };
  });

  /** Registers the stable account ids a listing was built from (two-operator review happens off-band). */
  app.post("/v1/admin/blokes/:ticker/sources", async (req) => {
    const token = req.headers["x-admin-token"];
    if (!ctx.env.ADMIN_API_TOKEN || token !== ctx.env.ADMIN_API_TOKEN) throw forbidden("admin_only", "Admin token required.");
    const { ticker: t } = z.object({ ticker }).parse(req.params);
    const body = z
      .object({
        sources: z
          .array(z.object({ kind: z.enum(["x", "reddit", "search", "hn", "commits", "releases", "onchain"]), externalId: z.string().min(1).max(128), handle: z.string().max(64).optional() }))
          .min(1)
          .max(12),
      })
      .parse(req.body);
    const b = await blokeByTicker(ctx, t);
    for (const s of body.sources) {
      await ctx.db.query(
        `INSERT INTO bloke_sources (bloke_id, kind, external_id, handle) VALUES ($1,$2,$3,$4)
         ON CONFLICT (bloke_id, kind, external_id) DO UPDATE SET handle = EXCLUDED.handle`,
        [b.id, s.kind, s.externalId, s.handle ?? null],
      );
    }
    return { data: { blokeId: b.id, sources: body.sources.length } };
  });
}
