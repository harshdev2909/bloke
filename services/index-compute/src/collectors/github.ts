import { isBotLogin } from "@bloke/index-core";
import { type Collector, type CollectedEvent, type PollResult, type SourceAccount, getJson } from "./types.js";

/**
 * GitHub WORK sources from the public events feed (PRD §4.1): `commits` from PushEvents, `releases`
 * from published ReleaseEvents. The account's external id is GitHub's stable numeric user id.
 * The feed covers the last 90 days (≤ 300 events), which also backfills the baseline on first poll.
 *
 * Without GITHUB_TOKEN the API allows 60 requests an hour; conditional requests (ETag → 304) don't
 * count against it, so idle accounts cost nothing.
 */
interface GhEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string };
  created_at: string;
  payload: { size?: number; distinct_size?: number; before?: string; head?: string; action?: string; release?: { draft?: boolean; prerelease?: boolean } };
}

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const DAY_MS = 86_400_000;
const DAILY_CAP = 50;
const MIN_STARS_OWN_REPO = 5;

export class GitHubCollector implements Collector {
  readonly kinds = ["commits", "releases"] as const;
  readonly intervalMs = 10 * 60_000;
  // Both kinds read the same feed; share one fetch per login per interval.
  private readonly feeds = new Map<string, { atMs: number; events: GhEvent[]; etag: string | null }>();
  private readonly stars = new Map<string, { atMs: number; stars: number }>();

  constructor(private readonly token = process.env.GITHUB_TOKEN) {}

  private headers(extra: Record<string, string> = {}) {
    return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(this.token && { authorization: `Bearer ${this.token}` }), ...extra };
  }

  async poll(a: SourceAccount, state: Record<string, unknown>, nowMs: number): Promise<PollResult> {
    let login = state.login as string | undefined;
    if (!login) {
      login = /^\d+$/.test(a.externalId) ? (await getJson<{ login: string }>(`${API}/user/${a.externalId}`, this.headers())).body!.login : a.externalId;
    }
    const feed = await this.feed(login, nowMs);
    const events: CollectedEvent[] = [];
    if (a.kind === "commits") {
      const perDay = new Map<number, number>();
      for (const e of [...feed.events].reverse()) {
        if (e.type !== "PushEvent") continue;
        const tMs = Date.parse(e.created_at);
        let n = e.payload.distinct_size ?? e.payload.size;
        // GitHub dropped commit counts from PushEvent payloads in 2025; fall back to compare.
        if (n === undefined && e.payload.before && e.payload.head) n = await this.compareCount(e.repo.name, e.payload.before, e.payload.head, state, e.id);
        n ??= 1;
        let filtered: string | undefined;
        if (isBotLogin(e.actor.login)) filtered = "bot";
        else if (e.repo.name.split("/")[0]?.toLowerCase() === login.toLowerCase() && (await this.repoStars(e.repo.name, nowMs)) < MIN_STARS_OWN_REPO) filtered = "repo_too_small";
        const day = Math.floor(tMs / DAY_MS);
        const used = perDay.get(day) ?? 0;
        const counted = filtered ? 0 : Math.max(0, Math.min(n, DAILY_CAP - used));
        if (!filtered && counted === 0) filtered = "daily_cap";
        perDay.set(day, used + counted);
        events.push({ ref: `push:${e.id}`, tMs, value: filtered ? n : counted, ...(filtered && { filtered }) });
      }
    } else {
      for (const e of feed.events) {
        if (e.type !== "ReleaseEvent" || e.payload.action !== "published" || e.payload.release?.draft) continue;
        events.push({ ref: `release:${e.id}`, tMs: Date.parse(e.created_at), value: e.payload.release?.prerelease ? 0.5 : 1 });
      }
    }
    return { events, state: { ...state, login }, mode: "insert" };
  }

  private async feed(login: string, nowMs: number) {
    const cached = this.feeds.get(login);
    if (cached && nowMs - cached.atMs < this.intervalMs / 2) return cached;
    const first = await getJson<GhEvent[]>(`${API}/users/${login}/events/public?per_page=100`, this.headers(cached?.etag ? { "if-none-match": cached.etag } : {}));
    if (first.status === 304 && cached) {
      cached.atMs = nowMs;
      return cached;
    }
    const events = [...(first.body ?? [])];
    for (let page = 2; page <= 3 && events.length === (page - 1) * 100; page++) {
      events.push(...((await getJson<GhEvent[]>(`${API}/users/${login}/events/public?per_page=100&page=${page}`, this.headers())).body ?? []));
    }
    const f = { atMs: nowMs, events, etag: first.etag };
    this.feeds.set(login, f);
    return f;
  }

  private async compareCount(repo: string, before: string, head: string, state: Record<string, unknown>, eventId: string): Promise<number> {
    const memo = (state.compare as Record<string, number> | undefined) ?? {};
    if (memo[eventId] !== undefined) return memo[eventId]!;
    try {
      const r = await getJson<{ total_commits: number }>(`${API}/repos/${repo}/compare/${before}...${head}`, this.headers());
      const n = r.body?.total_commits ?? 1;
      // Keep the memo small: event ids only matter while they're still in the 300-event feed.
      state.compare = Object.fromEntries([...Object.entries(memo), [eventId, n]].slice(-400));
      return n;
    } catch {
      return 1; // force-pushed or deleted branch: count the push once
    }
  }

  private async repoStars(repo: string, nowMs: number): Promise<number> {
    const c = this.stars.get(repo);
    if (c && nowMs - c.atMs < DAY_MS) return c.stars;
    const r = await getJson<{ stargazers_count: number }>(`${API}/repos/${repo}`, this.headers());
    const stars = r.body?.stargazers_count ?? 0;
    this.stars.set(repo, { atMs: nowMs, stars });
    return stars;
  }
}
