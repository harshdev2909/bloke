"use client";

import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Abi } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { gasLimitFromEstimate, messageFor } from "@bloke/sdk";

export type TxPhase = "idle" | "signing" | "submitted" | "confirmed" | "error";

/** Plain-language reason for a failed call, or null when the user simply declined. */
export function explain(err: unknown): string | null {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return null;
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName) return messageFor(rev.data.errorName);
    if (/rejected|denied/i.test(err.shortMessage)) return null;
    if (/insufficient funds/i.test(err.message)) return "Not enough MON for gas. Get some from the faucet on your profile.";
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Sends a contract write with Monad's gas policy (explicit limit = estimate × 1.15, because Monad bills
 * the limit) and tracks Submitted → Confirmed. Returns the receipt.
 */
export function useContractTx() {
  const pub = usePublicClient();
  const { data: wallet } = useWalletClient();
  const { address } = useAccount();
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  const send = useCallback(
    async (call: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] }) => {
      if (!pub || !wallet || !address) throw new Error("Connect a wallet first.");
      setError(null);
      setPhase("signing");
      try {
        const est = await pub.estimateContractGas({ ...call, account: address } as never);
        const h = await wallet.writeContract({ ...call, gas: gasLimitFromEstimate(est), chain: wallet.chain, account: address } as never);
        setHash(h);
        setPhase("submitted");
        const rc = await pub.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
        if (rc.status !== "success") throw new Error("The transaction reverted.");
        setPhase("confirmed");
        return rc;
      } catch (err) {
        const msg = explain(err);
        setPhase(msg ? "error" : "idle");
        setError(msg);
        throw err;
      }
    },
    [pub, wallet, address],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setHash(null);
  }, []);

  return { send, phase, error, hash, reset, setPhase, setError };
}
