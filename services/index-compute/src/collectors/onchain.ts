import { type Address, type PublicClient, getAddress, isAddress } from "viem";
import { type Collector, type PollResult, type SourceAccount } from "./types.js";

/**
 * On-chain WORK (PRD §4.1): transactions sent by the person's verified deployer or wallet address
 * on Monad, read as the account nonce. Each increase is one event. There's no backfill (that needs
 * an archive indexer), so the baseline starts from the cohort prior.
 */
const MAX_PER_POLL = 50; // a burst of scripted txs counts at most this much per minute

export class OnchainCollector implements Collector {
  readonly kinds = ["onchain"] as const;
  readonly intervalMs = 60_000;

  constructor(private readonly client: PublicClient) {}

  async poll(a: SourceAccount, state: Record<string, unknown>, nowMs: number): Promise<PollResult> {
    if (!isAddress(a.externalId)) throw new Error(`onchain source ${a.externalId} is not an address`);
    const nonce = await this.client.getTransactionCount({ address: getAddress(a.externalId) as Address, blockTag: "latest" });
    const prev = state.nonce as number | undefined;
    const events =
      prev !== undefined && nonce > prev ? [{ ref: `nonce:${nonce}`, tMs: nowMs, value: Math.min(nonce - prev, MAX_PER_POLL) }] : [];
    return { events, state: { ...state, nonce }, mode: "insert" };
  }
}
