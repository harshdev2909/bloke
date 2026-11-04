/**
 * Graduates a demo Bloke on the staging set, end to end through the API and contracts exactly as a
 * person would (PRD §10, amendment A17): list → claim with a linked identity → verify a deployer →
 * Live → post Skin → attestation → graduate. Uses the staging fast profile for the duration, then
 * restores the mainnet-intent profile.
 *
 * Run (services up): node demo/graduate.ts   (Node 24 strips the types)
 * Env: ADDRESSES, RPC_URL(S), API_URL, ADMIN_API_TOKEN, DEPLOYER_PRIVATE_KEY; TICKER (default ORION)
 *
 * Resumable: the demo person's key is kept in .state/demo-<TICKER>.json (gitignored), and steps
 * already done on chain are skipped on a rerun.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Hex, createPublicClient, createWalletClient, keccak256, parseEther, toHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BlokeClient, blokePoolAbi, blokeRegistryAbi, graduationLauncherAbi, protocolConfigAbi, testUSDCAbi } from "@bloke/sdk";
import { CHAINS, POLLING_INTERVAL_MS, gasLimitFromEstimate, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";
import { ensureLive } from "../test/helpers.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const a = loadAddresses(env("ADDRESSES"));
if (!a.launcher) throw new Error("this deployment has no launcher");
const chain = CHAINS[a.chainId]!;
const transport = rpcTransport(process.env.RPC_URLS ?? env("RPC_URL"));
const pub = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS });
const admin = createWalletClient({ chain, transport, account: privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex), pollingInterval: POLLING_INTERVAL_MS });
const TICKER = env("TICKER", "ORION");
const stateDir = new URL("../../../.state/", import.meta.url);
mkdirSync(stateDir, { recursive: true });
const keyFile = new URL(`demo-${TICKER}.json`, stateDir);
const personKey: Hex = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")).key : generatePrivateKey();
writeFileSync(keyFile, JSON.stringify({ key: personKey }));
const person = createWalletClient({ chain, transport, account: privateKeyToAccount(personKey), pollingInterval: POLLING_INTERVAL_MS });
const API = env("API_URL");
const api = new BlokeClient({ baseUrl: API });

async function write(w: typeof admin, call: Record<string, unknown>) {
  const est = await pub.estimateContractGas({ ...call, account: w.account } as never);
  const hash = await w.writeContract({ ...call, gas: gasLimitFromEstimate(est) } as never);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rc.status !== "success") throw new Error(`${String(call.functionName)} reverted`);
  return rc;
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 120_000, step = 1_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

const key = (k: string) => toHex(k, { size: 32 });
const setParam = (k: string, v: bigint) => write(admin, { address: a.protocolConfig, abi: protocolConfigAbi, functionName: "set", args: [key(k), v] });
const getParam = (k: string) => pub.readContract({ address: a.protocolConfig, abi: protocolConfigAbi, functionName: "get", args: [key(k)] });

const FAST: Record<string, bigint> = { GRAD_AVG_DAYS: 1n, GRAD_MIN_HCS: 1_000_000n, GRAD_MIN_OI_USDC: 0n, GRAD_MIN_TRADERS: 0n, GRAD_SKIN_DAYS: 0n };

async function main() {
  const saved: Record<string, bigint> = {};
  for (const k of Object.keys(FAST)) saved[k] = await getParam(k);
  log("person", { address: person.account.address });
  try {
    // 1. Gas and test money for the person (first run only).
    if ((await pub.getBalance({ address: person.account.address })) < parseEther("0.3")) {
      await admin.sendTransaction({ to: person.account.address, value: parseEther("0.6") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
      await write(admin, { address: a.tusdc, abi: testUSDCAbi, functionName: "mint", args: [person.account.address, 2_000_000_000n] });
    }

    // 2. List (or reuse) the demo Bloke and register the accounts it is priced from.
    const existing = await api.bloke(TICKER).catch(() => null);
    if (existing && existing.data.status === "graduated") throw new Error(`${TICKER} already graduated; set TICKER`);
    if (!existing) {
      await write(admin, {
        address: a.registry,
        abi: blokeRegistryAbi,
        functionName: "list",
        args: [{ ticker: toHex(TICKER, { size: 16 }), name: `${TICKER[0]}${TICKER.slice(1).toLowerCase()} (demo)`, sourceIdsHash: keccak256(toHex(TICKER)), tier: 2, workSourceMask: 5 }],
      });
    }
    const b = await until("listing indexed", async () => (await api.bloke(TICKER)).data);
    const identity = `${TICKER.toLowerCase()}-demo-${person.account.address.slice(2, 10).toLowerCase()}`;
    const res = await fetch(`${API}/v1/admin/blokes/${TICKER}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": env("ADMIN_API_TOKEN") },
      body: JSON.stringify({
        sources: [
          { kind: "commits", externalId: identity, handle: identity },
          { kind: "hn", externalId: `${TICKER} BLOKE demo` },
          { kind: "onchain", externalId: person.account.address },
        ],
      }),
    });
    if (!res.ok) throw new Error(`register sources: ${res.status} ${await res.text()}`);
    await fetch(`${API}/v1/admin/blokes/${TICKER}/archetype`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": env("ADMIN_API_TOKEN") },
      body: JSON.stringify({ archetype: "builder" }),
    });

    // 3. Sign in, link the identity the listing was built from, claim.
    const { message } = await api.siweMessage(person.account.address, a.chainId);
    const { token } = await api.signIn(message, await person.account.signMessage({ message }));
    api.setToken(token);
    await api.identityCallback("test", { externalId: identity, handle: identity, createdAt: "2020-01-01T00:00:00Z", followers: 50 });
    const claimedBy = await pub.readContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [b.id] });
    if (claimedBy === zeroAddress) {
      const { data: c } = await api.claimAttestation(TICKER);
      await write(person, { address: a.registry, abi: blokeRegistryAbi, functionName: "claim", args: [c.blokeId, BigInt(c.nonce), BigInt(c.expiry), c.signature] });
      log("claimed", { blokeId: c.blokeId });
    } else if (claimedBy !== person.account.address) throw new Error(`${TICKER} is claimed by another wallet; set TICKER`);

    // 4. Verify a deployer address the person controls.
    if ((await pub.readContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "bloke", args: [b.id] })).sourceBitmap === 0) {
      const deployer = privateKeyToAccount(generatePrivateKey());
      const { message: srcMsg } = await api.sourcesMessage(TICKER);
      const { data: s } = await api.verifySources(TICKER, [{ address: deployer.address, signature: await deployer.signMessage({ message: srcMsg }) }]);
      await write(person, { address: a.registry, abi: blokeRegistryAbi, functionName: "setSourceVerification", args: [s.blokeId, s.bitmap, s.linked, BigInt(s.nonce), BigInt(s.expiry), s.signature] });
      log("sources verified", { bitmap: s.bitmap });
    }

    // 5. Live, then Skin.
    await ensureLive(b.id);
    if ((await pub.readContract({ address: a.pool, abi: blokePoolAbi, functionName: "skin", args: [b.id] })) < 1_000_000_000n) {
      await write(person, { address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.pool, 1_000_000_000n] });
      await write(person, { address: a.pool, abi: blokePoolAbi, functionName: "postSkin", args: [b.id, 1_000_000_000n] });
    }
    log("live with Skin");

    // 5b. The person ships something on chain: small contract deploys from their wallet, which the
    // on-chain WORK source counts (a contract whose code returns 42).
    for (let i = 0; i < 3; i++) {
      const hash = await person.sendTransaction({ data: "0x600a600c600039600a6000f3602a60005260206000f3" });
      await pub.waitForTransactionReceipt({ hash });
    }
    log("deployed 3 contracts");

    // 6. Fast profile, then wait for every check.
    for (const [k, v] of Object.entries(FAST)) await setParam(k, v);
    const ready = await until(
      "all eight checks",
      async () => {
        const { data } = await api.bloke(TICKER);
        const failing = data.graduation.checks.filter((x) => !x.pass).map((x) => `${x.name}: ${x.value}`);
        if (failing.length) log("waiting", { failing });
        return failing.length ? undefined : data;
      },
      40 * 60_000, // today's average catches up as hourly checkpoints accrue
      15_000,
    );
    log("checks pass", { index: ready.index });

    // 7. Attestation from the API, graduate from the claimed wallet.
    const { data: g } = await api.attestGraduation(TICKER);
    const at = g.attestation;
    const rc = await write(person, {
      address: a.launcher,
      abi: graduationLauncherAbi,
      functionName: "graduate",
      args: [
        {
          blokeId: at.blokeId,
          traderCount: at.traderCount,
          airdropRoot: at.airdropRoot,
          airdropTotal: BigInt(at.airdropTotal),
          backerRoot: at.backerRoot,
          backerTotal: BigInt(at.backerTotal),
          nonce: BigInt(at.nonce),
          expiry: BigInt(at.expiry),
        },
        g.signature,
      ],
    });
    const view = await until("graduation view", async () => {
      const { data } = await api.graduation(TICKER);
      return data.graduated ? data : undefined;
    });
    log("graduated", { tx: rc.transactionHash, gasUsed: rc.gasUsed.toString(), token: view.token, pair: view.pair, price: view.price, lists: g.lists });
  } finally {
    // Restore whatever profile was set before.
    for (const [k, v] of Object.entries(saved)) if ((await getParam(k)) !== v) await setParam(k, v);
    log("profile restored", Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, v.toString()])));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
