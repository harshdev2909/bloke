/**
 * Opens a demo raise on the staging set (amendment A18): list → claim with a linked identity →
 * open a raise → a backer commits part of the goal. Leaves it open for people to back.
 *
 * Run (services up): node demo/raise.ts
 * Env: ADDRESSES, RPC_URL(S), API_URL, ADMIN_API_TOKEN, DEPLOYER_PRIVATE_KEY; TICKER (default LYRA),
 * GOAL (tUSDC, default 5000), BACKED (default 1750)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Hex, createPublicClient, createWalletClient, keccak256, parseEther, toHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BlokeClient, blokeRaiseAbi, blokeRegistryAbi, testUSDCAbi } from "@bloke/sdk";
import { CHAINS, POLLING_INTERVAL_MS, gasLimitFromEstimate, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }));

const a = loadAddresses(env("ADDRESSES"));
if (!a.raise) throw new Error("this deployment has no BlokeRaise");
const chain = CHAINS[a.chainId]!;
const transport = rpcTransport(process.env.RPC_URLS ?? env("RPC_URL"));
const pub = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS });
const admin = createWalletClient({ chain, transport, account: privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex), pollingInterval: POLLING_INTERVAL_MS });
const TICKER = env("TICKER", "LYRA");
const GOAL = BigInt(env("GOAL", "5000")) * 1_000_000n;
const BACKED = BigInt(env("BACKED", "1750")) * 1_000_000n;
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

async function until<T>(fn: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function main() {
  if ((await pub.getBalance({ address: person.account.address })) < parseEther("0.1")) {
    await admin.sendTransaction({ to: person.account.address, value: parseEther("0.2") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  }
  if (!(await api.bloke(TICKER).catch(() => null))) {
    await write(admin, {
      address: a.registry,
      abi: blokeRegistryAbi,
      functionName: "list",
      args: [{ ticker: toHex(TICKER, { size: 16 }), name: `${TICKER[0]}${TICKER.slice(1).toLowerCase()} (demo)`, sourceIdsHash: keccak256(toHex(TICKER)), tier: 2, workSourceMask: 5 }],
    });
  }
  const b = await until(async () => (await api.bloke(TICKER)).data);
  const identity = `${TICKER.toLowerCase()}-demo-${person.account.address.slice(2, 10).toLowerCase()}`;
  const admin2 = (path: string, body: unknown) =>
    fetch(`${API}/v1/admin/blokes/${TICKER}/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": env("ADMIN_API_TOKEN") }, body: JSON.stringify(body) });
  await admin2("sources", { sources: [{ kind: "commits", externalId: identity, handle: identity }, { kind: "hn", externalId: `${TICKER} BLOKE demo` }, { kind: "onchain", externalId: person.account.address }] });
  await admin2("archetype", { archetype: "creator" });

  const claimedBy = await pub.readContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "claimedWallet", args: [b.id] });
  if (claimedBy === zeroAddress) {
    const { message } = await api.siweMessage(person.account.address, a.chainId);
    api.setToken((await api.signIn(message, await person.account.signMessage({ message }))).token);
    await api.identityCallback("test", { externalId: identity, handle: identity, createdAt: "2020-01-01T00:00:00Z", followers: 50 });
    const { data: c } = await api.claimAttestation(TICKER);
    await write(person, { address: a.registry, abi: blokeRegistryAbi, functionName: "claim", args: [c.blokeId, BigInt(c.nonce), BigInt(c.expiry), c.signature] });
    log("claimed", { blokeId: c.blokeId });
  }

  let r = (await api.raise(TICKER)).data;
  if (!r || r.state !== "open") {
    await write(person, { address: a.raise, abi: blokeRaiseAbi, functionName: "open", args: [b.id, GOAL, 7n * 86_400n, 10_000_000n] });
    r = await until(async () => {
      const x = (await api.raise(TICKER)).data;
      return x?.state === "open" ? x : undefined;
    });
    log("raise opened", { id: r.id, goal: GOAL.toString() });
  }
  if (BigInt(r.raised) < BACKED) {
    await write(admin, { address: a.tusdc, abi: testUSDCAbi, functionName: "mint", args: [admin.account.address, BACKED] });
    await write(admin, { address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.raise, BACKED] });
    await write(admin, { address: a.raise, abi: blokeRaiseAbi, functionName: "commit", args: [BigInt(r.id), BACKED - BigInt(r.raised)] });
  }
  const done = await until(async () => {
    const x = (await api.raise(TICKER)).data;
    return x && BigInt(x.raised) >= BACKED ? x : undefined;
  });
  log("raise live", { ticker: TICKER, raised: done.raised, goal: done.goal, deadline: done.deadline, page: `/b/${TICKER}#raise` });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
