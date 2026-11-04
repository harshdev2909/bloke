import type { SourceId } from "@bloke/index-core";

/** A registered source account for one Bloke (row of bloke_sources). */
export interface SourceAccount {
  blokeId: number;
  kind: SourceId;
  externalId: string;
  handle: string | null;
  verified: boolean;
}

export interface CollectedEvent {
  /** Stable per-source reference (post id, sha, push event id, tx nonce, hour bucket). */
  ref: string;
  tMs: number;
  value: number;
  quality?: number;
  /** Set when a spam filter dropped it (PRD §4.3); stored for audit, not counted. */
  filtered?: string;
}

export interface PollResult {
  events: CollectedEvent[];
  /** Opaque collector state persisted in collector_state (cursors, ETags). */
  state: Record<string, unknown>;
  /**
   * "insert": events are immutable (posts, commits). "upsert": hourly counts that grow while the
   * hour is open (X counts, Trends), so a later poll replaces the value.
   */
  mode: "insert" | "upsert";
}

export interface Collector {
  kinds: readonly SourceId[];
  /** Poll cadence; the source is degraded after 3 missed polls. */
  intervalMs: number;
  poll(account: SourceAccount, state: Record<string, unknown>, nowMs: number): Promise<PollResult>;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} ${url.replace(/([?&](api_key|key|token)=)[^&]+/g, "$1…")}`);
  }
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<{ status: number; body: T | null; etag: string | null }> {
  const res = await fetch(url, { headers: { "user-agent": "bloke-index-compute/0.1", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { status: 304, body: null, etag: res.headers.get("etag") };
  if (!res.ok) throw new HttpStatusError(res.status, url);
  return { status: res.status, body: (await res.json()) as T, etag: res.headers.get("etag") };
}
