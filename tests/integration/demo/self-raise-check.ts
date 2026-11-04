/** Smoke check for "Start your raise" (A18): a fresh wallet lists itself, claims, opens a raise. */
import { type Hex, createPublicClient, createWalletClient, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BlokeClient, blokeRaiseAbi, blokeRegistryAbi } from "@bloke/sdk";
import { CHAINS, POLLING_INTERVAL_MS, gasLimitFromEstimate, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";

const a = loadAddresses(process.env.ADDRESSES!);
const chain = CHAINS[a.chainId]!;
const transport = rpcTransport(process.env.RPC_URLS ?? process.env.RPC_URL!);
const pub = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS });
const admin = createWalletClient({ chain, transport, account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex) });
const me = createWalletClient({ chain, transport, account: privateKeyToAccount(generatePrivateKey()) });
const api = new BlokeClient({ baseUrl: process.env.API_URL! });
const send = async (call: Record<string, unknown>) => {
  const est = await pub.estimateContractGas({ ...call, account: me.account } as never);
  const h = await me.writeContract({ ...call, gas: gasLimitFromEstimate(est) } as never);
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error(`${String(call.functionName)} reverted`);
};
await pub.waitForTransactionReceipt({ hash: await admin.sendTransaction({ to: me.account.address, value: parseEther("0.05") }) });
const { message } = await api.siweMessage(me.account.address, a.chainId);
api.setToken((await api.signIn(message, await me.account.signMessage({ message }))).token);
const ticker = `S${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const { data: c } = await api.startRaise({ ticker, name: "Self test", archetype: "founder" });
await send({ address: a.registry, abi: blokeRegistryAbi, functionName: "claim", args: [c.blokeId, BigInt(c.nonce), BigInt(c.expiry), c.signature] });
await send({ address: a.raise!, abi: blokeRaiseAbi, functionName: "open", args: [c.blokeId, 2_000_000_000n, 86_400n, 10_000_000n] });
for (let i = 0; i < 30; i++) {
  const r = (await api.raise(ticker)).data;
  if (r?.state === "open") {
    console.log(JSON.stringify({ ok: true, ticker, raiseId: r.id, goal: r.goal }));
    process.exit(0);
  }
  await new Promise((x) => setTimeout(x, 1000));
}
throw new Error("raise not visible");
