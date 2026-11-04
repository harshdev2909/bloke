"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { monadTestnet } from "@bloke/sdk";
import { api, qk } from "./api";

/** Signs in with SIWE when there's no session for the connected wallet; resolves once there is. */
export function useEnsureSession() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  return useCallback(async () => {
    if (!address) throw new Error("Connect a wallet first.");
    const s = await api.session().catch(() => null);
    if (s && s.data.address.toLowerCase() === address.toLowerCase()) return;
    const { message } = await api.siweMessage(address, monadTestnet.id);
    await api.signIn(message, await signMessageAsync({ message }));
    await qc.invalidateQueries({ queryKey: qk.session });
  }, [address, signMessageAsync, qc]);
}
