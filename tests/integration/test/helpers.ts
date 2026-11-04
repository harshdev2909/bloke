import { type Hex, createPublicClient, createWalletClient, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { blokeRegistryAbi, protocolConfigAbi } from "@bloke/sdk";
import { CHAINS, POLLING_INTERVAL_MS, gasLimitFromEstimate, rpcTransport } from "@bloke/shared";
import { loadAddresses } from "@bloke/shared/node";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Moves a Bloke from Shadow to Live if it isn't already. On staging the shadow period is shortened
 * to 60 s (config bound allows it only when `staging`). The pusher must be running so history exists.
 * Every suite calls this, so test files don't depend on run order.
 */
export async function ensureLive(blokeId: number) {
  const a = loadAddresses(process.env.ADDRESSES!);
  const chain = CHAINS[a.chainId]!;
  const transport = rpcTransport(process.env.RPC_URLS ?? process.env.RPC_URL!);
  const pub = createPublicClient({ chain, transport, pollingInterval: POLLING_INTERVAL_MS });
  const admin = createWalletClient({ chain, transport, account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex), pollingInterval: POLLING_INTERVAL_MS });
  const send = async (call: Record<string, unknown>) => {
    const est = await pub.estimateContractGas({ ...call, account: admin.account } as never);
    const hash = await admin.writeContract({ ...call, gas: gasLimitFromEstimate(est) } as never);
    await pub.waitForTransactionReceipt({ hash, timeout: 30_000 });
  };
  if ((await pub.readContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "status", args: [blokeId] })) !== 1) return;
  if (a.staging) {
    const key = toHex("SHADOW_SEC", { size: 32 });
    const cur = await pub.readContract({ address: a.protocolConfig, abi: protocolConfigAbi, functionName: "get", args: [key] });
    if (cur > 60n) await send({ address: a.protocolConfig, abi: protocolConfigAbi, functionName: "set", args: [key, 60n] });
  }
  for (let i = 0; i < 180; i++) {
    try {
      await pub.simulateContract({ address: a.registry, abi: blokeRegistryAbi, functionName: "goLive", args: [blokeId], account: admin.account });
      break;
    } catch {
      await sleep(1000);
    }
  }
  await send({ address: a.registry, abi: blokeRegistryAbi, functionName: "goLive", args: [blokeId] });
}
