"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { ApiError, type BlokeDetail, type PowItem } from "@bloke/sdk";
import { api } from "@/lib/api";
import { useEnsureSession } from "@/lib/session";
import { cn } from "@/lib/cn";

const KINDS: { id: PowItem["kind"]; label: string }[] = [
  { id: "contract", label: "Contract" },
  { id: "repo", label: "Repo" },
  { id: "release", label: "Release" },
  { id: "paper", label: "Paper" },
  { id: "product", label: "Product" },
  { id: "post", label: "Post" },
];

const STATUS: Record<PowItem["status"], { label: string; cls: string }> = {
  verified: { label: "Verified", cls: "bg-accent-wash text-deep" },
  self_reported: { label: "Self-reported", cls: "bg-canvas text-ink-2" },
  rejected: { label: "Not verified", cls: "bg-berry-wash text-berry" },
};

type Draft = { kind: PowItem["kind"]; title: string; url: string; ref: string };
const EMPTY: Draft = { kind: "contract", title: "", url: "", ref: "" };

/** Proof of work (A19, simulated): what the person shipped, verified where the chain can tell. */
export function PowPanel({ b }: { b: BlokeDetail }) {
  const { address } = useAccount();
  const qc = useQueryClient();
  const ensure = useEnsureSession();
  const q = useQuery({ queryKey: ["pow", b.ticker], queryFn: () => api.pow(b.ticker), refetchInterval: 30_000 });
  const mine = !!address && !!b.claimedWallet && address.toLowerCase() === b.claimedWallet.toLowerCase();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const v = q.data?.data;

  if (!v || (!mine && v.items.length === 0)) return null;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await ensure();
      const body = { kind: draft.kind, title: draft.title.trim(), url: draft.url.trim(), ...(draft.ref.trim() && { ref: draft.ref.trim() }) };
      if (editing) await api.updatePow(editing, body);
      else await api.addPow(b.ticker, body);
      setDraft(null);
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ["pow", b.ticker] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: number) => {
    setBusy(true);
    try {
      await ensure();
      await api.retractPow(id);
      await qc.invalidateQueries({ queryKey: ["pow", b.ticker] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="pow-h" className="tile p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="pow-h" className="display text-lg font-bold">
          Proof of work
        </h2>
        <span className="num text-sm text-ink-2">
          {v.verified}/{v.total} verified · <span className="text-pos">+{v.simulatedWorkBoost} WORK</span> <span className="text-ink-3">(simulated)</span>
        </span>
      </div>

      {v.items.length > 0 && (
        <ul className="mt-4 grid gap-2">
          {v.items.map((i) => (
            <li key={i.id} className="flex items-start gap-3 rounded-[18px] bg-canvas px-4 py-3 text-sm">
              <span className="mt-0.5 w-16 shrink-0 text-xs uppercase tracking-[0.12em] text-ink-3">{i.kind}</span>
              <div className="min-w-0 flex-1">
                <a href={i.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 font-medium hover:underline">
                  <span className="truncate">{i.title}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                </a>
                {i.note && <p className="num truncate text-xs text-ink-3">{i.note}</p>}
              </div>
              <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs", STATUS[i.status].cls)}>
                {i.status === "verified" && <BadgeCheck className="size-3.5" aria-hidden />}
                {STATUS[i.status].label}
              </span>
              {mine && (
                <span className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    aria-label={`Edit ${i.title}`}
                    onClick={() => {
                      setEditing(i.id);
                      setDraft({ kind: i.kind, title: i.title, url: i.url, ref: i.ref ?? "" });
                    }}
                    className="grid size-9 place-items-center rounded-full hover:bg-sand"
                  >
                    <Pencil className="size-4" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Remove ${i.title}`} disabled={busy} onClick={() => remove(i.id)} className="grid size-9 place-items-center rounded-full text-neg hover:bg-sand">
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {mine && !draft && (
        <button type="button" onClick={() => setDraft(EMPTY)} className="btn btn-ink mt-4 w-full">
          Add proof of work
        </button>
      )}

      {mine && draft && (
        <div className="mt-4 grid gap-3 rounded-[24px] bg-canvas p-4">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={draft.kind === k.id}
                onClick={() => setDraft({ ...draft, kind: k.id })}
                className={cn("h-9 rounded-full px-3.5 text-sm", draft.kind === k.id ? "bg-ink text-canvas" : "bg-sand text-ink-2")}
              >
                {k.label}
              </button>
            ))}
          </div>
          <label className="text-xs text-ink-3">
            Title
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={80} placeholder="What you shipped" className="field mt-1" />
          </label>
          <label className="text-xs text-ink-3">
            Link
            <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} type="url" inputMode="url" placeholder="https://" className="field mt-1" />
          </label>
          {draft.kind === "contract" && (
            <label className="text-xs text-ink-3">
              Deployment tx hash (Monad testnet)
              <input value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} placeholder="0x…" autoComplete="off" className="field num mt-1" />
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" disabled={busy || !draft.title.trim() || !/^https?:\/\//.test(draft.url.trim())} onClick={save} className="btn btn-accent flex-1">
              {busy ? "Saving…" : editing ? "Update" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditing(null);
              }}
              className="btn btn-quiet"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-ink-3">Contracts verify when your wallet deployed them; GitHub repos when the owner is your linked GitHub. Others show as self-reported.</p>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-2 text-sm text-neg">
          {err}
        </p>
      )}
    </section>
  );
}
