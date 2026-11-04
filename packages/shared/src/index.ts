import { type Address, type Chain, type Transport, defineChain, fallback, http, webSocket } from "viem";
import { foundry } from "viem/chains";

export * from "./abi/index.js";
export * from "./archetypes.js";

/** Monad testnet (PRD §20.1, re-verified 2026-11-04). 300 ms blocks, gas billed on the limit. */
export const monadTestnet: Chain = defineChain({
  id: 10_143,
  name: "Monad Testnet",
  // 300 ms blocks. Without this viem polls receipts every 4 s, which dominated fill latency.
  blockTime: 300,
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet-rpc.monad.xyz"], webSocket: ["wss://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: { default: { name: "MonadVision", url: "https://testnet.monadvision.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const CHAINS: Record<number, Chain> = { [monadTestnet.id]: monadTestnet, [foundry.id]: foundry };

/**
 * Transport from a comma-separated RPC list. Several URLs fail over in order with retries, which
 * rides out the public Monad RPCs' intermittent rate-limit timeouts (amendment A10i).
 */
export function rpcTransport(urls: string): Transport {
  const list = urls.split(",").map((u) => u.trim()).filter(Boolean);
  const one = (u: string) =>
    u.startsWith("ws") ? webSocket(u, { retryCount: 3 }) : http(u, { timeout: 20_000, retryCount: 3, retryDelay: 300 });
  return list.length === 1 ? one(list[0]!) : fallback(list.map(one), { retryCount: 2 });
}

/** Receipt and block polling interval for every client (Monad finalizes in ~600 ms). */
export const POLLING_INTERVAL_MS = 250;

/** Gas limit policy: Monad charges the limit, so always set estimate × 1.15 explicitly (PRD §14.5). */
export function gasLimitFromEstimate(estimate: bigint): bigint {
  return (estimate * 115n) / 100n;
}

export interface Addresses {
  chainId: number;
  startBlock: number;
  staging: boolean;
  accessManager: Address;
  protocolConfig: Address;
  tusdc: Address;
  oracle: Address;
  registry: Address;
  pool: Address;
  engine: Address;
  settler: Address;
  // P4 graduation set (absent on deployments before it)
  tbloke?: Address;
  desk?: Address;
  v2Factory?: Address;
  v2Router?: Address;
  lpLocker?: Address;
  vesting?: Address;
  distributor?: Address;
  launcher?: Address;
  repRoots?: Address;
  raise?: Address;
}


// ---------------------------------------------------------------- oracle EIP-712

export interface IndexEntry {
  blokeId: number;
  b: number;
  h: number;
  w: number;
}

export interface IndexPush {
  seq: bigint;
  tsMs: bigint;
  paramsVersion: `0x${string}`;
  entries: IndexEntry[];
}

export const ORACLE_TYPES = {
  IndexPush: [
    { name: "seq", type: "uint64" },
    { name: "tsMs", type: "uint64" },
    { name: "paramsVersion", type: "bytes32" },
    { name: "entries", type: "IndexEntry[]" },
  ],
  IndexEntry: [
    { name: "blokeId", type: "uint32" },
    { name: "b", type: "uint32" },
    { name: "h", type: "uint32" },
    { name: "w", type: "uint32" },
  ],
} as const;

export function oracleDomain(chainId: number, oracle: Address) {
  return { name: "BLOKE Oracle", version: "1", chainId, verifyingContract: oracle } as const;
}

/** Index scale used on-chain: 100.0 → 1_000_000. */
export const INDEX_SCALE = 10_000;
export const INDEX_MIN = 5_000;
export const INDEX_MAX = 2_000_000;

// ---------------------------------------------------------------- real-time stream

/** Real-time message published after the batch commits (Redis → API → WebSocket, PRD §13.4). */
export type StreamEvent =
  | { type: "index"; blokeId: number; b: number; h: number; w: number; lagFlags: number; seq: string; tsMs: string }
  | { type: "push"; seq: string; tsMs: string; entries: number }
  | {
      type: "order";
      owner: `0x${string}`;
      orderId: string;
      marketId?: number;
      status: "requested" | "filled" | "rejected" | "cancelled" | "expired" | "deferred";
      reason?: string;
      lotId?: string;
      fillPrice?: string;
      txHash: `0x${string}`;
    }
  | {
      type: "lot";
      owner: `0x${string}`;
      lotId: string;
      marketId: number;
      status: string;
      exitPrice: string;
      pricePnl: string;
      fundingPnl: string;
      fee: string;
      payout: string;
      txHash: `0x${string}`;
    }
  | { type: "bloke"; blokeId: number; status: string }
  | { type: "epoch"; epoch: string; g: string };


/** Redis pub/sub channel the indexer publishes committed events to; every API instance subscribes. */
export const STREAM_CHANNEL = "bloke:events";
