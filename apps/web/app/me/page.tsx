"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Check, Droplets, Github, KeyRound, Loader2, Twitter, Wallet } from "lucide-react";
import { ApiError, blokePoolAbi, blokeRegistryAbi, merkleDistributorAbi, monadTestnet, testUSDCAbi, vestingStreamAbi } from "@bloke/sdk";
import { tokens } from "@/components/graduation";
import { api, qk, useAddresses, useStatus } from "@/lib/api";
import { parseUsdc, usdc } from "@/lib/format";
import { explain, useContractTx } from "@/lib/tx";
import { WalletButton } from "@/components/wallet-button";
import { cn } from "@/lib/cn";
import { Art } from "@/components/art";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : explain(e) ?? "Cancelled.");

export default function MePage() {
  const { address, status } = useAccount();
  const qc = useQueryClient();
  const { signMessageAsync } = useSignMessage();
  const staging = useStatus().data?.data.staging ?? false;
  const session = useQuery({
    queryKey: [...qk.session, address],
    queryFn: () => api.session(),
    enabled: !!address,
    retry: false,
  });
  const signedIn = !!session.data && session.data.data.address.toLowerCase() === address?.toLowerCase();
  const identities = session.data?.data.identities ?? [];
  const qualifying = identities.some((i) => i.qualifies);

  const signIn = useMutation({
    mutationFn: async () => {
      const { message } = await api.siweMessage(address!, monadTestnet.id);
      const signature = await signMessageAsync({ message });
      return api.signIn(message, signature);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.session }),
  });

  const linkGithub = useMutation({
    mutationFn: async () => {
      const { url } = await api.identityStart("github", `${location.origin}/auth/github`);
      location.href = url;
    },
  });
  const linkX = useMutation({
    mutationFn: async () => {
      const { url } = await api.identityStart("x", `${location.origin}/auth/x`);
      location.href = url;
    },
  });
  const linkTest = useMutation({
    mutationFn: () =>
      api.identityCallback("test", {
        externalId: `web-${address!.slice(2, 12).toLowerCase()}`,
        handle: `tester-${address!.slice(2, 8).toLowerCase()}`,
        createdAt: "2023-01-01T00:00:00Z",
        followers: 50,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.session }),
  });

  const faucet = useMutation({
    mutationFn: () => api.faucet(),
    onSuccess: () => address && qc.invalidateQueries({ queryKey: qk.wallet(address) }),
  });

  const steps = [
    {
      icon: Wallet,
      title: "Connect a wallet",
      done: status === "connected",
      body: <WalletButton />,
    },
    {
      icon: KeyRound,
      title: "Sign in",
      done: signedIn,
      body: (
        <ActionButton onClick={() => signIn.mutate()} pending={signIn.isPending} disabled={status !== "connected"} error={signIn.error && errText(signIn.error)}>
          Sign in with Ethereum
        </ActionButton>
      ),
      hint: "Proves you own this wallet. No transaction, no gas.",
    },
    {
      icon: Github,
      title: "Link GitHub or X",
      done: qualifying,
      body: (
        <div className="flex flex-wrap gap-2">
          <ActionButton onClick={() => linkGithub.mutate()} pending={linkGithub.isPending} disabled={!signedIn} error={linkGithub.error && errText(linkGithub.error)}>
            <Github className="size-4" aria-hidden /> GitHub
          </ActionButton>
          <ActionButton onClick={() => linkX.mutate()} pending={linkX.isPending} disabled={!signedIn} tone="ghost" error={linkX.error && errText(linkX.error)}>
            <Twitter className="size-4" aria-hidden /> X
          </ActionButton>
          {staging && (
            <ActionButton onClick={() => linkTest.mutate()} pending={linkTest.isPending} disabled={!signedIn} tone="ghost" error={linkTest.error && errText(linkTest.error)}>
              Use a test identity
            </ActionButton>
          )}
        </div>
      ),
      hint: "One identity, one faucet claim a day. GitHub accounts need to be 30+ days old; X accounts 90+ days with 10+ followers.",
    },
    {
      icon: Droplets,
      title: "Get 10,000 tUSDC",
      done: faucet.isSuccess,
      body: (
        <ActionButton onClick={() => faucet.mutate()} pending={faucet.isPending} disabled={!qualifying} error={faucet.error && errText(faucet.error)}>
          Claim tUSDC and gas
        </ActionButton>
      ),
      hint: faucet.isSuccess
        ? `Sent ${usdc(faucet.data.data.amount)} tUSDC${faucet.data.data.dripTxHash ? " and a little MON for gas" : ""}. You can trade now.`
        : "We send the transaction for you, plus a little MON for gas the first time, so a brand-new wallet can trade right away.",
    },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_380px]">
      <section aria-labelledby="onb-h">
        <h1 id="onb-h" className="display text-4xl font-extrabold md:text-5xl">
          Get set up
        </h1>
        <p className="mt-2 max-w-[52ch] text-ink-2">Four steps, about a minute. Everything here is testnet money with no value.</p>
        <ol className="relative mt-8 space-y-4">
          {/* Curved connector behind the steps */}
          <svg className="absolute left-[27px] top-6 h-[calc(100%-48px)] w-6" preserveAspectRatio="none" viewBox="0 0 24 100" aria-hidden>
            <path d="M12 0 C 24 25, 0 50, 12 75 S 12 100, 12 100" fill="none" stroke="#836EF9" strokeOpacity="0.3" strokeWidth="2" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
          </svg>
          {steps.map((s, i) => {
            const Icon = s.icon;
            const active = i === current;
            return (
              <motion.li
                key={s.title}
                layout
                className={cn("tile relative flex gap-4 p-5", active && "shadow-[inset_0_0_0_2px_#5B44E8]")}
              >
                <span
                  className={cn(
                    "relative z-10 grid size-14 shrink-0 place-items-center rounded-full transition-colors duration-150",
                    s.done ? "bg-pos/10 text-pos" : active ? "bg-accent-ink text-white" : "bg-canvas text-ink-3",
                  )}
                >
                  {s.done ? <Check className="size-6" aria-hidden /> : <Icon className="size-6" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="display text-xl font-bold">
                    <span className="sr-only">Step {i + 1}: </span>
                    {s.title}
                    {s.done && <span className="sr-only"> (done)</span>}
                  </h2>
                  {"hint" in s && s.hint && <p className="mt-1 text-sm text-ink-2">{s.hint}</p>}
                  {!s.done && <div className="mt-4">{s.body}</div>}
                  {i === 2 && identities.length > 0 && (
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {identities.map((id) => (
                        <li key={id.provider + id.externalId} className="rounded-full inline-flex h-8 items-center gap-2 bg-canvas px-3 text-xs">
                          {id.provider === "github" ? <Github className="size-3.5" aria-hidden /> : id.provider === "x" ? <Twitter className="size-3.5" aria-hidden /> : null}
                          {id.handle ?? id.externalId}
                          <span className={id.qualifies ? "text-pos" : "text-neg"}>{id.qualifies ? "eligible" : "too new"}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </motion.li>
            );
          })}
        </ol>
        {current === -1 && (
          <Link href="/" className="rounded-full mt-6 inline-flex h-12 items-center bg-accent-ink px-6 font-semibold text-white hover:bg-deep">
            Go to the floor
          </Link>
        )}
      </section>
      <aside className="space-y-6">
        <Art slot="onboarding" className="hidden w-full lg:block" sizes="380px" />
        <ClaimsPanel />
        <SkinPanel />
        <ClaimProfile signedIn={signedIn} />
      </aside>
    </div>
  );
}

/** Tokens from graduations: early-long airdrops, backer shares and the person's vesting stream. */
function ClaimsPanel() {
  const { address } = useAccount();
  const a = useAddresses();
  const tx = useContractTx();
  const q = useQuery({ queryKey: ["claims", address], queryFn: () => api.claims(address!), enabled: !!address, refetchInterval: 30_000 });
  const rows = (q.data?.data ?? []).filter((c) => !c.claimed && BigInt(c.amount) > 0n);
  if (!rows.length) return null;
  const busy = tx.phase === "signing" || tx.phase === "submitted";
  return (
    <section aria-labelledby="claims-h" className="tile p-6">
      <h2 id="claims-h" className="display text-xl font-bold">
        Claims
      </h2>
      <ul className="mt-4 space-y-2">
        {rows.map((c) => (
          <li key={`${c.kind}${c.distributionId}`} className="flex items-center justify-between gap-3 rounded-[18px] bg-canvas px-4 py-3 text-sm">
            <span>
              <span className="num font-medium">
                {tokens(c.amount)} ${c.ticker}
              </span>
              <span className="block text-xs text-ink-3">{c.kind === "airdrop" ? "Early long" : c.kind === "backer" ? "Backer" : "Vested"}</span>
            </span>
            <button
              type="button"
              disabled={busy || !a?.distributor || !a.vesting}
              onClick={async () => {
                try {
                  if (c.kind === "vesting") await tx.send({ address: a!.vesting!, abi: vestingStreamAbi, functionName: "claim", args: [BigInt(c.distributionId)] });
                  else await tx.send({ address: a!.distributor!, abi: merkleDistributorAbi, functionName: "claim", args: [BigInt(c.distributionId), address!, BigInt(c.amount), c.proof] });
                  q.refetch();
                } catch {
                  // tx.error explains
                }
              }}
              className="btn btn-ink h-9 px-4 text-sm"
            >
              Claim
            </button>
          </li>
        ))}
      </ul>
      {tx.error && <p className="mt-2 text-sm text-neg">{tx.error}</p>}
    </section>
  );
}

/** Skin: the person's own first-loss stake. 25% of fees instead of 15%, and a graduation check. */
function SkinPanel() {
  const { address } = useAccount();
  const a = useAddresses();
  const tx = useContractTx();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("1000");
  const w = useQuery({ queryKey: qk.wallet(address ?? "0x"), queryFn: () => api.wallet(address!), enabled: !!address, refetchInterval: 10_000 });
  const profiles = w.data?.data.profiles ?? [];
  if (!profiles.length || !a) return null;
  const value = parseUsdc(amount);
  const busy = tx.phase === "signing" || tx.phase === "submitted";
  const act = async (blokeId: number, kind: "post" | "withdraw") => {
    if (value === null || value === 0n) return;
    try {
      if (kind === "post") {
        await tx.send({ address: a.tusdc, abi: testUSDCAbi, functionName: "approve", args: [a.pool, value] });
        await tx.send({ address: a.pool, abi: blokePoolAbi, functionName: "postSkin", args: [blokeId, value] });
      } else {
        await tx.send({ address: a.pool, abi: blokePoolAbi, functionName: "requestSkinWithdraw", args: [blokeId, value] });
      }
      qc.invalidateQueries({ queryKey: qk.wallet(address!) });
    } catch {}
  };
  return (
    <section aria-labelledby="skin-h" className="tile p-6">
      <h2 id="skin-h" className="display text-xl font-bold">
        Skin
      </h2>
      <p className="mt-1 text-sm text-ink-2">Back yourself: Skin takes first loss on your markets and lifts your fee share from 15% to 25%.</p>
      {profiles.map((p) => (
        <div key={p.blokeId} className="mt-5">
          <p className="flex items-baseline justify-between">
            <span className="font-medium">${p.ticker}</span>
            <span className="num text-xl">{usdc(p.skin)}</span>
          </p>
          <p className="mt-1 text-sm text-ink-3">{p.hasSkin ? `25% fee share${p.skinSince ? ` · since ${new Date(p.skinSince).toLocaleDateString()}` : ""}` : "Post 1,000 tUSDC for the 25% tier"}</p>
          <label htmlFor={`skin-${p.blokeId}`} className="sr-only">
            Amount
          </label>
          <input id={`skin-${p.blokeId}`} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} className="field num mt-3" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy || value === null} onClick={() => act(p.blokeId, "post")} className="btn btn-accent">
              Post
            </button>
            <button type="button" disabled={busy || value === null || BigInt(p.skin) === 0n} onClick={() => act(p.blokeId, "withdraw")} className="btn btn-quiet">
              Withdraw
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3">Withdrawals settle at the next hourly settlement; Skin backing open positions stays locked.</p>
        </div>
      ))}
      {tx.error && <p className="mt-3 text-sm text-neg">{tx.error}</p>}
    </section>
  );
}

function ClaimProfile({ signedIn }: { signedIn: boolean }) {
  const a = useAddresses();
  const tx = useContractTx();
  const [ticker, setTicker] = useState("");
  const [done, setDone] = useState(false);
  const claim = useMutation({
    mutationFn: async () => {
      const { data } = await api.claimAttestation(ticker.toUpperCase());
      await tx.send({ address: a!.registry, abi: blokeRegistryAbi, functionName: "claim", args: [data.blokeId, BigInt(data.nonce), BigInt(data.expiry), data.signature] });
      setDone(true);
    },
  });
  return (
    <section aria-labelledby="claim-h" className="tile p-6">
      <h2 id="claim-h" className="display text-xl font-bold">
        Are you listed?
      </h2>
      <p className="mt-1 text-sm text-ink-2">Claim your profile with the GitHub or X account it was listed from. You earn 15% of fees on your markets.</p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          claim.mutate();
        }}
      >
        <label htmlFor="claim-ticker" className="block text-sm text-ink-2">
          Your ticker
        </label>
        <input
          id="claim-ticker"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
          placeholder="FOUNDER"
          autoComplete="off"
          className="num h-12 w-full rounded-[18px] bg-white px-4 shadow-[inset_0_0_0_1px_#E4E0DC] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_2px_#5B44E8]"
        />
        <ActionButton type="submit" pending={claim.isPending} disabled={!signedIn || ticker.length < 2 || done} error={claim.error && errText(claim.error)}>
          {done ? "Claimed" : "Claim profile"}
        </ActionButton>
        {!signedIn && <p className="text-xs text-ink-3">Sign in first.</p>}
      </form>
    </section>
  );
}

function ActionButton({
  children,
  onClick,
  pending,
  disabled,
  error,
  tone = "primary",
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  pending?: boolean;
  disabled?: boolean;
  error?: string | null | false;
  tone?: "primary" | "ghost";
  type?: "button" | "submit";
}) {
  return (
    <div>
      <button
        type={type}
        onClick={onClick}
        disabled={disabled || pending}
        aria-busy={pending}
        className={cn(
          "rounded-full inline-flex h-11 items-center gap-2 px-5 text-sm font-medium transition-[transform,background-color] duration-100 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50",
          tone === "primary" ? "bg-accent-ink text-white hover:bg-deep" : "bg-sand-2 text-ink hover:bg-sand-2",
        )}
      >
        {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {children}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-neg">
          {error}
        </p>
      )}
    </div>
  );
}
