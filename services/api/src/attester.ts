import { randomBytes } from "node:crypto";
import { type Address, concat, keccak256, pad } from "viem";
import type { Ctx } from "./context.js";

/** Attestations expire well inside the contracts' 10-minute maximum (PRD §16.2). */
export const ATTESTATION_TTL_SEC = 300;

export const randomNonce = () => BigInt(`0x${randomBytes(32).toString("hex")}`);
export const expiryFromNow = () => BigInt(Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SEC);

/** Matches Solidity's keccak256(abi.encodePacked(address[])): array elements are padded to 32 bytes. */
export function linkedHash(linked: Address[]): `0x${string}` {
  return keccak256(linked.length ? concat(linked.map((a) => pad(a, { size: 32 }))) : "0x");
}

const registryDomain = (ctx: Ctx) => ({ name: "BLOKE Registry", version: "1", chainId: ctx.a.chainId, verifyingContract: ctx.a.registry }) as const;

export function signFaucet(ctx: Ctx, identityHash: `0x${string}`, wallet: Address, expiry: bigint) {
  return ctx.attester.signTypedData({
    domain: { name: "BLOKE Test USDC", version: "1", chainId: ctx.a.chainId, verifyingContract: ctx.a.tusdc },
    types: { Faucet: [{ name: "identityHash", type: "bytes32" }, { name: "wallet", type: "address" }, { name: "expiry", type: "uint64" }] },
    primaryType: "Faucet",
    message: { identityHash, wallet, expiry },
  });
}

export function signClaim(ctx: Ctx, blokeId: number, wallet: Address, nonce: bigint, expiry: bigint) {
  return ctx.attester.signTypedData({
    domain: registryDomain(ctx),
    types: {
      Claim: [
        { name: "blokeId", type: "uint32" },
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "Claim",
    message: { blokeId, wallet, nonce, expiry },
  });
}

export function signSources(ctx: Ctx, blokeId: number, bitmap: number, linked: Address[], nonce: bigint, expiry: bigint) {
  return ctx.attester.signTypedData({
    domain: registryDomain(ctx),
    types: {
      Sources: [
        { name: "blokeId", type: "uint32" },
        { name: "bitmap", type: "uint8" },
        { name: "linkedHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint64" },
      ],
    },
    primaryType: "Sources",
    message: { blokeId, bitmap, linkedHash: linkedHash(linked), nonce, expiry },
  });
}

/**
 * Serialises transactions from the shared relayer key across every API instance with a Redis lock,
 * so horizontally scaled instances never race on the nonce.
 */
export async function withRelayerLock<T>(ctx: Ctx, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  const key = "lock:relayer";
  const token = randomBytes(16).toString("hex");
  const t0 = Date.now();
  while (!(await ctx.redis.set(key, token, "PX", 60_000, "NX"))) {
    if (Date.now() - t0 > waitMs) throw new Error("relayer busy");
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    // Release only our own lock.
    await ctx.redis.eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, key, token);
  }
}

/** Fixed-window per-wallet limit for attestations (PRD §13.4: 10 per hour per wallet). */
export async function attestationBudget(ctx: Ctx, wallet: Address): Promise<boolean> {
  const key = `attest:${wallet.toLowerCase()}:${Math.floor(Date.now() / 3_600_000)}`;
  const n = await ctx.redis.incr(key);
  if (n === 1) await ctx.redis.expire(key, 3_700);
  return n <= ctx.env.ATTESTATIONS_PER_HOUR;
}
