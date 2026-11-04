"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Copy } from "lucide-react";
import { monadTestnet } from "@bloke/sdk";
import { shortAddr } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Sigil } from "./sigil";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

const MONAD_HEX = `0x${monadTestnet.id.toString(16)}`;
const ADD_PARAMS = {
  chainId: MONAD_HEX,
  chainName: monadTestnet.name,
  nativeCurrency: monadTestnet.nativeCurrency,
  rpcUrls: monadTestnet.rpcUrls.default.http,
  blockExplorerUrls: [monadTestnet.blockExplorers!.default.url],
};

function errCode(e: unknown): number | undefined {
  const x = e as { code?: number; data?: { originalError?: { code?: number } }; cause?: { code?: number } };
  return x?.data?.originalError?.code ?? x?.cause?.code ?? x?.code;
}

/**
 * Switches the wallet to Monad Testnet, adding the network first when the wallet doesn't know it.
 * Wallets disagree on the "unknown chain" code (4902, -32603, wrapped, or none), so anything except
 * a user rejection falls through to wallet_addEthereumChain.
 */
async function switchToMonad(provider: Eip1193) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_HEX }] });
  } catch (e) {
    if (errCode(e) === 4001) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [ADD_PARAMS] });
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_HEX }] }).catch(() => {});
  }
}

/** Four states, each its own UI: disconnected, connecting, wrong network, connected. */
export function WalletButton() {
  const { address, status, chainId, connector } = useAccount();
  const { connect, connectors, isPending, error: connectError, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const click = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, [open]);

  async function onSwitch() {
    setSwitching(true);
    setSwitchError(null);
    try {
      const provider = (await connector?.getProvider()) as Eip1193 | undefined;
      if (!provider) throw new Error("No wallet provider");
      await switchToMonad(provider);
    } catch (e) {
      setSwitchError(errCode(e) === 4001 ? "Request declined in wallet" : `${connector?.name ?? "This wallet"} can't switch to Monad Testnet. Disconnect and pick MetaMask`);
    } finally {
      setSwitching(false);
    }
  }

  if (status !== "connected" || !address) {
    // Every wallet announced through EIP-6963, MetaMask first; the generic window.ethereum shim only
    // when nothing announced itself. Several extensions installed side by side is common, so the
    // user picks rather than whichever announced first.
    const announced = connectors.filter((x) => x.id !== "injected");
    const seen = new Set<string>();
    const wallets = (announced.length ? announced : connectors)
      .filter((x) => !seen.has(x.id) && seen.add(x.id))
      .sort((a, b) => Number(b.id === "io.metamask") - Number(a.id === "io.metamask"));
    const busy = isPending || status === "connecting";
    return (
      <div className="relative" ref={ref}>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            reset();
            if (!wallets.length) window.open("https://metamask.io/download/", "_blank", "noopener");
            else if (wallets.length === 1) connect({ connector: wallets[0]! });
            else setOpen((o) => !o);
          }}
          className="btn btn-ink h-11 px-5 text-sm"
        >
          {busy ? "Check your wallet…" : wallets.length ? "Connect" : "Install a wallet"}
        </button>
        <AnimatePresence>
          {open && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
              className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 rounded-[24px] bg-white p-2 shadow-[0_20px_50px_-20px_rgb(14_16_15/0.25),0_0_0_1px_#E4E0DC]"
            >
              {wallets.map((w) => (
                <button
                  key={w.uid}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    connect({ connector: w });
                  }}
                  className="flex w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left text-sm hover:bg-sand"
                >
                  {w.icon ? <img src={w.icon} alt="" className="size-6 rounded-md" /> : <span className="size-6 rounded-md bg-sand" aria-hidden />}
                  {w.name}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        {connectError && !busy && !open && (
          <p role="alert" className="absolute right-0 top-[calc(100%+6px)] whitespace-nowrap rounded-full bg-white px-3 py-1 text-xs text-neg shadow-[0_0_0_1px_#E4E0DC]">
            {errCode(connectError) === 4001 ? "Request declined in wallet" : "Couldn't connect. Unlock your wallet and retry"}
          </p>
        )}
      </div>
    );
  }
  if (chainId !== monadTestnet.id) {
    return (
      <div className="relative flex items-center gap-2">
        <button type="button" disabled={switching} aria-busy={switching} onClick={onSwitch} className="btn h-11 bg-berry-wash px-5 text-sm text-berry hover:bg-berry/15">
          {switching ? "Check your wallet…" : "Switch to Monad"}
        </button>
        <button type="button" onClick={() => disconnect()} className="btn btn-quiet h-11 px-4 text-sm" aria-label="Disconnect wallet">
          Disconnect
        </button>
        {switchError && (
          <p role="alert" className="absolute right-0 top-[calc(100%+6px)] whitespace-nowrap rounded-full bg-white px-3 py-1 text-xs text-neg shadow-[0_0_0_1px_#E4E0DC]">
            {switchError}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="btn btn-quiet h-11 gap-2 pl-2 pr-4 text-sm">
        <Sigil ticker={address} size={28} />
        <span className="num">{shortAddr(address)}</span>
        <ChevronDown className={cn("size-4 transition-transform duration-150", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
            className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 rounded-[24px] bg-white p-2 shadow-[0_20px_50px_-20px_rgb(14_16_15/0.25),0_0_0_1px_#E4E0DC]"
          >
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="flex w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left text-sm hover:bg-sand"
            >
              {copied ? <Check className="size-4 text-pos" aria-hidden /> : <Copy className="size-4 text-ink-3" aria-hidden />}
              {copied ? "Copied" : "Copy address"}
            </button>
            <Link role="menuitem" href="/me" onClick={() => setOpen(false)} className="flex w-full items-center rounded-[16px] px-4 py-3 text-sm hover:bg-sand">
              Profile and faucet
            </Link>
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="flex w-full items-center rounded-[16px] px-4 py-3 text-left text-sm text-neg hover:bg-sand"
            >
              Disconnect
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
