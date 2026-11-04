import { type Collector, type CollectedEvent, type PollResult, type SourceAccount, getJson } from "./types.js";

/**
 * Sources that need paid or approved API access (amendment A11). Each runs only when its key is
 * set; without one the source is unavailable and drops out of every Bloke's leg.
 *
 * Neither has been exercised against the live API in this repo (no keys yet). Both report hourly
 * counts, upserted while the hour is open.
 */

/** X mentions via the v2 counts endpoint: tweets mentioning @handle, retweets excluded. */
export class XCountsCollector implements Collector {
  readonly kinds = ["x"] as const;
  readonly intervalMs = 15 * 60_000;

  constructor(private readonly bearer: string) {}

  async poll(a: SourceAccount, state: Record<string, unknown>): Promise<PollResult> {
    if (!a.handle) throw new Error("x source needs a handle");
    const q = encodeURIComponent(`@${a.handle} -is:retweet -from:${a.handle}`);
    const r = await getJson<{ data: { start: string; tweet_count: number }[] }>(
      `https://api.x.com/2/tweets/counts/recent?query=${q}&granularity=hour`,
      { authorization: `Bearer ${this.bearer}` },
    );
    const events: CollectedEvent[] = (r.body?.data ?? []).map((d) => ({ ref: `xh:${d.start}`, tMs: Date.parse(d.start), value: d.tweet_count }));
    return { events, state, mode: "upsert" };
  }
}

/** Search interest via SerpApi's Google Trends engine (0–100 relative interest, hourly over 7 days). */
export class TrendsCollector implements Collector {
  readonly kinds = ["search"] as const;
  readonly intervalMs = 60 * 60_000;

  constructor(private readonly key: string) {}

  async poll(a: SourceAccount, state: Record<string, unknown>): Promise<PollResult> {
    const q = encodeURIComponent(a.externalId);
    const r = await getJson<{ interest_over_time?: { timeline_data: { timestamp: string; values: { extracted_value: number }[] }[] } }>(
      `https://serpapi.com/search.json?engine=google_trends&data_type=TIMESERIES&date=now%207-d&q=${q}&api_key=${this.key}`,
    );
    const events: CollectedEvent[] = (r.body?.interest_over_time?.timeline_data ?? []).map((d) => ({
      ref: `trends:${d.timestamp}`,
      tMs: Number(d.timestamp) * 1000,
      value: (d.values[0]?.extracted_value ?? 0) / 10,
    }));
    return { events, state, mode: "upsert" };
  }
}
