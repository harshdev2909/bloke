/** HYPE-leg bot and brigade filters (PRD §4.3). */

const DAY_MS = 86_400_000;

export interface XMention {
  id: string;
  authorId: string;
  authorCreatedMs: number;
  followers: number;
  text: string;
  tMs: number;
}

export interface Accepted {
  id: string;
  value: number;
  tMs: number;
}

export interface Dropped {
  id: string;
  reason: "author_young" | "author_followers" | "author_daily_cap" | "near_duplicate" | "reddit_author" | "brigade_hour";
}

export interface FilterResult {
  accepted: Accepted[];
  dropped: Dropped[];
}

export const X_RULES = {
  minAccountAgeDays: 90,
  minFollowers: 50,
  perAuthorDailyCap: 3,
  duplicateSimilarity: 0.8,
};

export function xQuality(followers: number): number {
  return Math.min(1, Math.log10(1 + followers) / 4);
}

/**
 * Filters X mentions. Input order doesn't matter: mentions are processed by time so the per-author
 * cap and duplicate collapse keep the earliest occurrences.
 */
export function filterXMentions(mentions: readonly XMention[], nowMs: number): FilterResult {
  const sorted = [...mentions].sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id));
  const accepted: Accepted[] = [];
  const dropped: Dropped[] = [];
  const perAuthorDay = new Map<string, number>();
  const signatures: Uint32Array[] = [];

  for (const m of sorted) {
    if (nowMs - m.authorCreatedMs < X_RULES.minAccountAgeDays * DAY_MS) {
      dropped.push({ id: m.id, reason: "author_young" });
      continue;
    }
    if (m.followers < X_RULES.minFollowers) {
      dropped.push({ id: m.id, reason: "author_followers" });
      continue;
    }
    const key = `${m.authorId}:${Math.floor(m.tMs / DAY_MS)}`;
    const count = perAuthorDay.get(key) ?? 0;
    if (count >= X_RULES.perAuthorDailyCap) {
      dropped.push({ id: m.id, reason: "author_daily_cap" });
      continue;
    }
    const sig = minhash(m.text);
    if (signatures.some((s) => minhashSimilarity(s, sig) >= X_RULES.duplicateSimilarity)) {
      dropped.push({ id: m.id, reason: "near_duplicate" });
      continue;
    }
    signatures.push(sig);
    perAuthorDay.set(key, count + 1);
    accepted.push({ id: m.id, value: xQuality(m.followers), tMs: m.tMs });
  }
  return { accepted, dropped };
}

export interface RedditItem {
  id: string;
  authorAgeDays: number;
  authorKarma: number;
  subreddit: string;
  score: number;
  tMs: number;
}

export const REDDIT_RULES = { minAccountAgeDays: 30, minKarma: 100, maxSubredditShare: 0.4 };

/** Upvote-weighted value, with any single subreddit capped at 40% of the total. */
export function filterReddit(items: readonly RedditItem[]): FilterResult {
  const accepted: Accepted[] = [];
  const dropped: Dropped[] = [];
  const kept: RedditItem[] = [];
  for (const it of items) {
    if (it.authorAgeDays < REDDIT_RULES.minAccountAgeDays || it.authorKarma < REDDIT_RULES.minKarma) {
      dropped.push({ id: it.id, reason: "reddit_author" });
      continue;
    }
    kept.push(it);
  }
  const raw = (it: RedditItem) => 1 + Math.log10(1 + Math.max(0, it.score));
  const total = kept.reduce((a, it) => a + raw(it), 0);
  const bySub = new Map<string, number>();
  for (const it of kept) bySub.set(it.subreddit, (bySub.get(it.subreddit) ?? 0) + raw(it));

  // Cap each subreddit so its share of the final total is at most maxShare. With others = total − s,
  // the cap c satisfies c / (others + c) = maxShare.
  const scale = new Map<string, number>();
  for (const [sub, s] of bySub) {
    const others = total - s;
    const share = REDDIT_RULES.maxSubredditShare;
    const cap = others > 0 ? (share * others) / (1 - share) : s;
    scale.set(sub, s > cap ? cap / s : 1);
  }
  for (const it of kept) accepted.push({ id: it.id, value: raw(it) * (scale.get(it.subreddit) ?? 1), tMs: it.tMs });
  return { accepted, dropped };
}

export interface HourActivity {
  id: string;
  authorAgeDays: number;
  /** Near-duplicate cluster id (same MinHash cluster), if any. */
  clusterId?: string;
}

export const BRIGADE_RULES = { youngAccountDays: 30, maxShare: 0.6 };

/**
 * Brigade guard: if more than 60% of an hour's HYPE activity comes from accounts under 30 days old or
 * from one similarity cluster, the hour is excluded and an abuse flag is raised.
 */
export function brigadeCheck(hour: readonly HourActivity[]): { excluded: boolean; reason?: string } {
  if (hour.length < 10) return { excluded: false }; // too little activity to call a brigade
  const young = hour.filter((a) => a.authorAgeDays < BRIGADE_RULES.youngAccountDays).length;
  if (young / hour.length > BRIGADE_RULES.maxShare) return { excluded: true, reason: "young_accounts" };
  const clusters = new Map<string, number>();
  for (const a of hour) if (a.clusterId) clusters.set(a.clusterId, (clusters.get(a.clusterId) ?? 0) + 1);
  for (const [id, n] of clusters) {
    if (n / hour.length > BRIGADE_RULES.maxShare) return { excluded: true, reason: `cluster:${id}` };
  }
  return { excluded: false };
}

// ---------------------------------------------------------------- MinHash

const K = 64;

function fnv1a(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function shingles(text: string, n = 3): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}@#$ ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export function minhash(text: string): Uint32Array {
  const sig = new Uint32Array(K).fill(0xffffffff);
  for (const s of shingles(text)) {
    for (let k = 0; k < K; k++) {
      const h = fnv1a(s, k * 0x9e3779b1);
      if (h < sig[k]!) sig[k] = h;
    }
  }
  return sig;
}

export function minhashSimilarity(a: Uint32Array, b: Uint32Array): number {
  let eq = 0;
  for (let k = 0; k < K; k++) if (a[k] === b[k]) eq++;
  return eq / K;
}
