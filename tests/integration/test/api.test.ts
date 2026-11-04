/**
 * Frontend-facing API, end to end, through @bloke/sdk exactly as the web app will use it.
 * Needs: chain + contracts, indexer (with REDIS_URL), oracle-pusher, keeper and services/api running.
 *
 * Env: ADDRESSES, RPC_URL, API_URL, ADMIN_API_TOKEN, DEPLOYER_PRIVATE_KEY (lister), MOCK_OAUTH_PORT
 * (the API's GITHUB_*_URL point at the mock provider this file starts).
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Hex, createPublicClient, createWalletClient, decodeEventLog, keccak256, toHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ApiError, BlokeClient, BlokeStream, type StreamMessage, blokeDeskAbi, blokeRaiseAbi, blokeRegistryAbi, marketEngineAbi, testUSDCAbi } from "@bloke/sdk";
import { CHAINS, POLLING_INTERVAL_MS, gasLimitFromEstimate, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import { ensureLive } from "./helpers.js";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const a = loadAddresses(env("ADDRESSES"));
const chain = CHAINS[a.chainId]!;
const rpc = process.env.RPC_URLS ?? env("RPC_URL");
const pub = createPublicClient({ chain, transport: rpcTransport(rpc), pollingInterval: POLLING_INTERVAL_MS });
const lister = createWalletClient({ chain, transport: rpcTransport(rpc), account: privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex), pollingInterval: POLLING_INTERVAL_MS });
const API = env("API_URL");
const trader = privateKeyToAccount(generatePrivateKey());
const tw = createWalletClient({ chain, transport: rpcTransport(rpc), account: trader, pollingInterval: POLLING_INTERVAL_MS });
const api = new BlokeClient({ baseUrl: API });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let claimedTicker: string | undefined; // set by F6/F7, graduated-checked by the P4 test

async function write(wallet: typeof tw | typeof lister, call: Record<string, unknown>) {
  const est = await pub.estimateContractGas({ ...call, account: wallet.account } as never);
  const hash = await wallet.writeContract({ ...call, gas: gasLimitFromEstimate(est) } as never);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  expect(rc.status).toBe("success");
  return rc;
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 30_000, step = 300): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await sleep(step);
  }
}

// ---------------------------------------------------------------- mock GitHub OAuth provider

const GH_ID = String(Math.floor(Math.random() * 1e12)); // fresh identity per run (faucet cooldown is per identity)
let mock: Server;
function startMockGithub(port: number) {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url?.startsWith("/token")) {
        const code = JSON.parse(body || "{}").code;
        return res.end(JSON.stringify(code === "good-code" ? { access_token: "tok-good" } : { error: "bad_verification_code" }));
      }
      if (req.url === "/api/user") {
        if (req.headers.authorization !== "Bearer tok-good") return res.writeHead(401).end("{}");
        return res.end(JSON.stringify({ id: Number(GH_ID), login: `it-${GH_ID}`, created_at: "2022-01-01T00:00:00Z", followers: 42 }));
      }
      res.writeHead(404).end("{}");
    });
  });
  return new Promise<void>((r) => mock.listen(port, "127.0.0.1", () => r()));
}

let stream: BlokeStream;
let listedId: number | undefined;
const received: StreamMessage[] = [];

describe("frontend API", () => {
  beforeAll(async () => {
    await startMockGithub(Number(env("MOCK_OAUTH_PORT", "18555")));
    await ensureLive(1); // FOUNDER
    stream = new BlokeStream({ url: API.replace(/^http/, "ws") + "/v1/stream" });
    stream.on((m) => received.push(m));
  });
  afterAll(async () => {
    stream?.close();
    // Hide this run's listing from the floor and raise pages (it stays on chain and indexed).
    if (claimedTicker) {
      await fetch(`${API}/v1/admin/blokes/${claimedTicker}/hidden`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": env("ADMIN_API_TOKEN") },
        body: JSON.stringify({ hidden: true }),
      }).catch(() => undefined);
    }
    mock?.close();
    // Remove the Bloke this run listed so staging's floor doesn't fill with test profiles.
    if (listedId !== undefined) {
      await write(lister, { address: a.registry, abi: blokeRegistryAbi, functionName: "requestDelist", args: [listedId] }).catch(() => undefined);
      await write(lister, { address: a.registry, abi: blokeRegistryAbi, functionName: "approveDelist", args: [listedId] }).catch(() => undefined);
    }
  });

  it("reads work without a session and say where each figure comes from", async () => {
    const blokes = await api.blokes();
    const founder = blokes.data.find((b) => b.ticker === "FOUNDER");
    expect(founder).toBeDefined();
    expect(blokes.meta.sources.index).toBe("on-chain");
    const detail = await api.bloke("FOUNDER");
    expect(detail.data.markets.map((m) => m.leg)).toEqual(["blend", "hype", "work"]);
    expect(detail.data.graduation.checks).toHaveLength(8);
    const status = await api.status();
    expect(status.data.oracle.lastPushAgeMs).not.toBeNull();
    expect(status.data.oracle.lastPushAgeMs!).toBeLessThan(90_000);
    const pool = await api.pool();
    expect(BigInt(pool.data.capBase)).toBeGreaterThan(0n);
    await expect(api.bloke("NOPE")).rejects.toMatchObject({ status: 404 });
  });

  it("SIWE sign-in: server-built message, single-use nonce, session cookie or bearer token", async () => {
    await expect(api.faucet()).rejects.toMatchObject({ status: 401 });
    const { message } = await api.siweMessage(trader.address, a.chainId);
    expect(message).toContain(trader.address);
    const signature = await trader.signMessage({ message });
    const { session } = await api.signIn(message, signature);
    expect(session.address).toBe(trader.address);
    // replaying the same signed message fails: the nonce is consumed
    await expect(new BlokeClient({ baseUrl: API }).signIn(message, signature)).rejects.toMatchObject({ status: 401 });
  });

  it("GitHub OAuth links the stable numeric id; a bad code is rejected", async () => {
    const { url, state } = await api.identityStart("github", "http://localhost:3000/auth/github");
    expect(url).toContain(`state=${state}`);
    await expect(api.identityCallback("github", { code: "bad", state })).rejects.toBeInstanceOf(ApiError);
    const s2 = await api.identityStart("github", "http://localhost:3000/auth/github");
    const { data } = await api.identityCallback("github", { code: "good-code", state: s2.state });
    expect(data.identities).toEqual([{ provider: "github", externalId: GH_ID, handle: `it-${GH_ID}`, qualifies: true }]);
  });

  it("A8: a wallet with zero MON gets tUSDC and gas through the relayed faucet; cooldown holds", async () => {
    expect(await pub.getBalance({ address: trader.address })).toBe(0n);
    const { data } = await api.faucet();
    expect(data.dripTxHash).not.toBeNull();
    expect(await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] })).toBe(BigInt(data.amount));
    expect(await pub.getBalance({ address: trader.address })).toBeGreaterThan(0n);
    await expect(api.faucet()).rejects.toMatchObject({ status: 429, code: "FaucetCooldown" });
  });

  let lotId: bigint;

  it("trade with live WebSocket updates on orders:{wallet} and index:FOUNDER", async () => {
    stream.subscribe(`orders:${trader.address.toLowerCase()}`, "index:FOUNDER", "feed");
    await sleep(300);
    const marketId = (await api.bloke("FOUNDER")).data.markets[2]!.marketId; // .WORK
    await write(tw, { address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.engine, 2n ** 255n] });
    const rc = await write(tw, { address: a.engine, abi: marketEngineAbi, functionName: "requestOpen", args: [marketId, 1, 250_000_000n, 300, 0n] });
    const req = rc.logs
      .map((l) => {
        try {
          return decodeEventLog({ abi: marketEngineAbi, data: l.data, topics: l.topics });
        } catch {
          return undefined;
        }
      })
      .find((e) => e?.eventName === "OrderRequested");
    const orderId = (req!.args as { orderId: bigint }).orderId.toString();

    const filled = await until(async () =>
      received.find((m) => m.channel.startsWith("orders:") && m.event.type === "order" && m.event.orderId === orderId && m.event.status === "filled"),
    );
    expect(filled.event.type === "order" && filled.event.lotId).toBeTruthy();
    lotId = BigInt((filled.event as { lotId: string }).lotId);
    expect(received.some((m) => m.channel === "orders:" + trader.address.toLowerCase() && m.event.type === "order" && m.event.status === "requested")).toBe(true);
    await until(async () => received.find((m) => m.channel === "index:FOUNDER" && m.event.type === "index" && m.event.ticker === "FOUNDER"), 45_000);
  });

  it("portfolio shows the open lot with live equity, then the close", async () => {
    const view = await until(async () => {
      const w = await api.wallet(trader.address);
      return w.data.lots.find((l) => l.lotId === lotId.toString() && l.equity) ? w : undefined;
    });
    const lot = view.data.lots.find((l) => l.lotId === lotId.toString())!;
    expect(lot.ticker).toBe("FOUNDER");
    expect(lot.leg).toBe("work");
    expect(BigInt(lot.equity!)).toBeGreaterThan(0n);
    expect(view.meta.sources.equity).toBe("on-chain");

    await write(tw, { address: a.engine, abi: marketEngineAbi, functionName: "requestClose", args: [lotId, 500] });
    await until(async () => received.find((m) => m.event.type === "lot" && m.event.lotId === lotId.toString()));
    const after = await until(async () => {
      const w = await api.wallet(trader.address);
      return w.data.lots.find((l) => l.lotId === lotId.toString() && l.close) ? w : undefined;
    });
    expect(BigInt(after.data.lots.find((l) => l.lotId === lotId.toString())!.close!.payout)).toBeGreaterThan(0n);
    const trades = await api.trades(lot.marketId);
    expect(trades.data.some((t) => t.lotId === lotId.toString() && t.kind === "close")).toBe(true);
    const chart = await api.index("FOUNDER", { range: "1h" });
    expect(chart.data.length).toBeGreaterThan(0);
  });

  it("F6/F7: claim a profile and verify a deployer address, all through attestations", async () => {
    const ticker = `IT${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 10);
    claimedTicker = ticker;
    await write(lister, {
      address: a.registry,
      abi: blokeRegistryAbi,
      functionName: "list",
      args: [{ ticker: toHex(ticker, { size: 16 }), name: "Integration Bloke", sourceIdsHash: keccak256(toHex(ticker)), tier: 3, workSourceMask: 7 }],
    });
    await until(() => api.bloke(ticker));
    // Operator registers the account ids the listing was built from (the trader's GitHub id).
    const res = await fetch(`${API}/v1/admin/blokes/${ticker}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": env("ADMIN_API_TOKEN") },
      body: JSON.stringify({ sources: [{ kind: "commits", externalId: GH_ID, handle: `it-${GH_ID}` }] }),
    });
    expect(res.status).toBe(200);

    const { data: c } = await api.claimAttestation(ticker);
    listedId = c.blokeId;
    await write(tw, { address: a.registry, abi: blokeRegistryAbi, functionName: "claim", args: [c.blokeId, BigInt(c.nonce), BigInt(c.expiry), c.signature] });
    expect(await pub.readContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [c.blokeId] })).toBe(trader.address);
    await expect(api.claimAttestation(ticker)).rejects.toMatchObject({ status: 409 });

    const deployer = privateKeyToAccount(generatePrivateKey());
    const { message } = await api.sourcesMessage(ticker);
    const { data: s } = await api.verifySources(ticker, [{ address: deployer.address, signature: await deployer.signMessage({ message }) }]);
    expect(s.bitmap).toBe(0b111);
    await write(tw, {
      address: a.registry,
      abi: blokeRegistryAbi,
      functionName: "setSourceVerification",
      args: [s.blokeId, s.bitmap, s.linked, BigInt(s.nonce), BigInt(s.expiry), s.signature],
    });
    expect(await pub.readContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "isLinked", args: [s.blokeId, deployer.address] })).toBe(true);
    // A forged deployer signature is refused.
    const other = privateKeyToAccount(generatePrivateKey());
    await expect(api.verifySources(ticker, [{ address: deployer.address, signature: await other.signMessage({ message }) }])).rejects.toMatchObject({ status: 400 });
  });

  it("suggestions, reports, and phase-gated endpoints", async () => {
    const h = `it_${Date.now()}`;
    expect((await api.suggest(`@${h}`)).data.first).toBe(true);
    expect((await api.suggest(h)).data.first).toBe(false);
    expect((await api.report({ kind: "abuse", ticker: "FOUNDER", body: "integration test report" })).data.id).toBeTruthy();
    const g = await fetch(`${API}/v1/graduations/FOUNDER/attest`, { method: "POST" });
    expect(g.status).toBe(401); // live since P4; needs a session
    const admin = await fetch(`${API}/v1/admin/blokes/FOUNDER/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(admin.status).toBe(403);
  });

  it("P4: graduation checklist from the launcher, the attestation gate, and the tBLOKE desk", async (ctx) => {
    if (!a.launcher || !a.desk || !a.tbloke || !claimedTicker) return ctx.skip();
    // All eight checks come from GraduationLauncher.checks now (reads are cached ~2 s, so wait for F7's bitmap).
    const b = await until(async () => {
      const { data } = await api.bloke(claimedTicker!);
      return data.graduation.checks[1]?.pass ? data : undefined;
    }, 15_000);
    expect(b.graduation.checks).toHaveLength(8);
    expect(b.graduation.checks.every((c) => c.available)).toBe(true);
    expect(b.graduation.checks[1]!.pass).toBe(true); // the verified deployer from F7
    expect(b.graduation.checks[0]!.pass).toBe(false); // still in Shadow
    // The claimed wallet gets a reasoned refusal while checks fail; anyone else is refused outright.
    await expect(api.attestGraduation(claimedTicker)).rejects.toMatchObject({ status: 409, code: "checks_failed" });
    await expect(api.attestGraduation("FOUNDER")).rejects.toMatchObject({ status: 403, code: "not_claimed_wallet" });
    const { data: g } = await api.graduation(claimedTicker);
    expect(g.graduated).toBe(false);
    expect(g.predictedToken).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The desk sells tBLOKE at 0.04 tUSDC.
    await write(tw, { address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.desk, 40_000_000n] });
    const before = await pub.readContract({ address: a.tbloke, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] });
    await write(tw, { address: a.desk, abi: blokeDeskAbi, functionName: "buy", args: [40_000_000n, 1_000n * 10n ** 18n] });
    const after = await pub.readContract({ address: a.tbloke, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] });
    expect(after - before).toBe(1_000n * 10n ** 18n);
  });

  it("A18: a claimed person raises, another wallet backs it to the goal, the person withdraws", async (ctx) => {
    if (!a.raise || !claimedTicker) return ctx.skip();
    const { data: b } = await api.bloke(claimedTicker);
    await write(tw, { address: a.raise, abi: blokeRaiseAbi, functionName: "open", args: [b.id, 1_000_000_000n, 3_600n, 10_000_000n] });
    const r = await until(async () => (await api.raise(claimedTicker!, lister.account.address)).data ?? undefined);
    expect(r.state).toBe("open");
    // The person can't back themselves; the lister (a stranger here) backs it past the goal and is clipped.
    await expect(pub.simulateContract({ address: a.raise, abi: blokeRaiseAbi, functionName: "commit", args: [BigInt(r.id), 100_000_000n], account: trader })).rejects.toThrow(/SelfCommit/);
    await write(lister, { address: a.tusdc, abi: testUSDCAbi, functionName: "mint", args: [lister.account.address, 2_000_000_000n] });
    await write(lister, { address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.raise, 2_000_000_000n] });
    await write(lister, { address: a.raise, abi: blokeRaiseAbi, functionName: "commit", args: [BigInt(r.id), 1_500_000_000n] });
    const done = await until(async () => {
      const { data } = await api.raise(claimedTicker!, lister.account.address);
      return data?.state === "succeeded" && data.backers === 1 ? data : undefined;
    });
    expect(done.raised).toBe("1000000000");
    expect(done.committed).toBe("1000000000");
    const before = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] });
    await write(tw, { address: a.raise, abi: blokeRaiseAbi, functionName: "withdraw", args: [BigInt(r.id)] });
    const after = await pub.readContract({ address: a.tusdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader.address] });
    expect(after - before).toBe(1_000_000_000n);
    expect((await api.raises()).data.some((x) => x.id === r.id)).toBe(true);
  });

  it("horizontal scaling: a second API instance shares sessions and the live stream", async (ctx) => {
    const B = process.env.API_URL_B;
    if (!B) return ctx.skip();
    // Same bearer token, different instance: sessions live in Redis, not in process memory.
    const tokenClient = new BlokeClient({ baseUrl: B });
    const { message } = await api.siweMessage(trader.address, a.chainId);
    const { token } = await api.signIn(message, await trader.signMessage({ message }));
    tokenClient.setToken(token);
    expect((await tokenClient.session()).data.address).toBe(trader.address);
    // B's stream sees an event produced while the trader talks to A.
    const got: StreamMessage[] = [];
    const sB = new BlokeStream({ url: B.replace(/^http/, "ws") + "/v1/stream" });
    sB.on((m) => got.push(m));
    sB.subscribe("status");
    try {
      await until(async () => got.find((m) => m.channel === "status" && m.event.type === "push"), 60_000);
    } finally {
      sB.close();
    }
  });

  it("logout ends the session", async () => {
    await api.signOut();
    await expect(api.session()).rejects.toMatchObject({ status: 401 });
    expect(zeroAddress).toBe("0x0000000000000000000000000000000000000000");
  });
});
