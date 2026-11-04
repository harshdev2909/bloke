import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  type Account,
  BaseError,
  ContractFunctionRevertedError,
} from "viem";
import { type IndexPush, ORACLE_TYPES, gasLimitFromEstimate, humanIndexOracleAbi, oracleDomain, settlerAbi } from "@bloke/shared";

/** Signs pushes. Production uses a KMS-backed signer; the pusher never sees the private key (PRD §5.5). */
export interface PushSigner {
  address(): Address;
  signPush(push: IndexPush): Promise<Hex>;
}

/** Signer backed by a viem account (local key in dev/CI; a KMS account adapter in production). */
export class AccountSigner implements PushSigner {
  constructor(
    private readonly account: Account & { signTypedData: NonNullable<Account["signTypedData"]> },
    private readonly chainId: number,
    private readonly oracle: Address,
  ) {}

  address(): Address {
    return this.account.address;
  }

  signPush(push: IndexPush): Promise<Hex> {
    return this.account.signTypedData({
      domain: oracleDomain(this.chainId, this.oracle),
      types: ORACLE_TYPES,
      primaryType: "IndexPush",
      message: push,
    });
  }
}

export interface LagState {
  blokeId: number;
  lagFlags: number;
}

/** The pusher's view of the chain. Kept narrow so tests can fake it. */
export interface OracleChain {
  lastSeq(): Promise<bigint>;
  lagFlags(blokeIds: number[]): Promise<LagState[]>;
  /**
   * Submits and waits for inclusion; with order ids, goes through Settler.pushAndSettle so the
   * orders fill in the same transaction. Throws PushRejected with the decoded error name on revert.
   */
  submit(push: IndexPush, sig: Hex, orderIds?: bigint[]): Promise<Hex>;
}

export class PushRejected extends Error {
  constructor(public readonly errorName: string, cause?: unknown) {
    super(`push rejected: ${errorName}`, { cause });
  }
}

export class ViemOracleChain implements OracleChain {
  constructor(
    private readonly publicClient: PublicClient<Transport, Chain>,
    private readonly walletClient: WalletClient<Transport, Chain, Account>,
    private readonly oracle: Address,
    private readonly settler?: Address,
  ) {}

  lastSeq(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.oracle, abi: humanIndexOracleAbi, functionName: "lastSeq" });
  }

  async lagFlags(blokeIds: number[]): Promise<LagState[]> {
    const results = await Promise.all(
      blokeIds.map((id) =>
        this.publicClient.readContract({ address: this.oracle, abi: humanIndexOracleAbi, functionName: "latest", args: [id] }),
      ),
    );
    return results.map((r, i) => ({ blokeId: blokeIds[i]!, lagFlags: r.lagFlags }));
  }

  async submit(push: IndexPush, sig: Hex, orderIds: bigint[] = []): Promise<Hex> {
    const viaSettler = this.settler !== undefined && orderIds.length > 0;
    const call = viaSettler
      ? ({ address: this.settler!, abi: settlerAbi, functionName: "pushAndSettle", args: [push, sig, orderIds, []] } as const)
      : ({ address: this.oracle, abi: humanIndexOracleAbi, functionName: "push", args: [push, sig] } as const);
    try {
      // Monad bills the gas limit: always set estimate × 1.15 explicitly (PRD §14.5).
      const estimate = await this.publicClient.estimateContractGas({ ...call, account: this.walletClient.account } as never);
      const hash = await this.walletClient.writeContract({ ...call, gas: gasLimitFromEstimate(estimate) } as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 10_000 });
      if (receipt.status !== "success") throw new PushRejected("Reverted");
      return hash;
    } catch (err) {
      if (err instanceof PushRejected) throw err;
      if (err instanceof BaseError) {
        const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
        if (revert instanceof ContractFunctionRevertedError) {
          throw new PushRejected(revert.data?.errorName ?? "Reverted", err);
        }
      }
      throw err;
    }
  }
}
