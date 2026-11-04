import { type Collector, type CollectedEvent, type PollResult, type SourceAccount, getJson } from "./types.js";

/**
 * Hacker News mentions (amendment A16) through the public Algolia API, no key needed. The account's
 * external id is the search phrase (a name or project, matched as a phrase); `handle` is the
 * person's own HN username, whose posts are excluded as self-promotion.
 */
interface Hit {
  objectID: string;
  author: string;
  created_at_i: number;
  points: number | null;
  _tags: string[];
}

const API = process.env.HN_API_URL ?? "https://hn.algolia.com/api/v1";
const BACKFILL_DAYS = 30;

export class HackerNewsCollector implements Collector {
  readonly kinds = ["hn"] as const;
  readonly intervalMs = 5 * 60_000;

  async poll(a: SourceAccount, state: Record<string, unknown>, nowMs: number): Promise<PollResult> {
    const since = (state.sinceS as number | undefined) ?? Math.floor(nowMs / 1000) - BACKFILL_DAYS * 86_400;
    const q = encodeURIComponent(`"${a.externalId.replace(/"/g, "")}"`);
    const events: CollectedEvent[] = [];
    let newest = since;
    for (let page = 0; page < 10; page++) {
      const r = await getJson<{ hits: Hit[]; nbPages: number }>(
        `${API}/search_by_date?query=${q}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=100&page=${page}`,
      );
      for (const h of r.body!.hits) {
        newest = Math.max(newest, h.created_at_i);
        const story = h._tags.includes("story");
        // A story counts more as it collects points; a comment is a lighter mention.
        const value = story ? 1 + Math.log2(1 + Math.max(0, h.points ?? 0)) / 4 : 0.5;
        const self = a.handle !== null && h.author.toLowerCase() === a.handle.toLowerCase();
        events.push({ ref: `hn:${h.objectID}`, tMs: h.created_at_i * 1000, value, ...(self && { filtered: "self_mention" }) });
      }
      if (page + 1 >= r.body!.nbPages) break;
    }
    return { events, state: { ...state, sinceS: newest }, mode: "insert" };
  }
}
