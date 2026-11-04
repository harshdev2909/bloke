import { describe, expect, it } from "vitest";
import {
  computable,
  paramsForSources,
  DAY_MS,
  DEFAULT_PARAMS,
  type IndexParams,
  type SourceState,
  addEvent,
  baselineFromSamples,
  brigadeCheck,
  compareSemver,
  computeIndex,
  decayTo,
  degradedZ,
  distinctExternalCallers,
  earlinessMultiplier,
  earlyPoints,
  filterCommits,
  filterReddit,
  filterXMentions,
  legWeights,
  paramsVersion,
  publishQualifies,
  shrinkToCohort,
  squash,
  validateParams,
  zScore,
} from "../src/index.js";

const NOW = Date.UTC(2026, 10, 4, 12);
const base = { mu: 10, sigma: 2, nDays: 30 };
const healthy = (x: number, verified = true): SourceState => ({ x, baseline: base, verified });
const allNormal = () => ({
  x: healthy(10),
  reddit: healthy(10),
  search: healthy(10),
  hn: healthy(10),
  commits: healthy(10),
  releases: healthy(10),
  onchain: healthy(10),
});

describe("math", () => {
  it("squash maps 0 to 1 and stays in (0, 2)", () => {
    expect(squash(0)).toBe(1);
    expect(squash(40)).toBeLessThanOrEqual(2);
    expect(squash(-40)).toBeGreaterThanOrEqual(0);
  });

  it("decay halves after τ·ln2 and is order independent", () => {
    const tau = 6;
    const d = decayTo({ level: 8, tMs: 0 }, tau * Math.LN2 * 3_600_000, tau);
    expect(d.level).toBeCloseTo(4, 10);
    const a = addEvent(addEvent({ level: 0, tMs: 0 }, 1, 1000, tau), 1, 5000, tau);
    const b = addEvent(addEvent({ level: 0, tMs: 0 }, 1, 5000, tau), 1, 1000, tau);
    expect(a.level).toBeCloseTo(b.level, 12);
  });

  it("baseline excludes the last 24h", () => {
    const today = Math.floor(NOW / DAY_MS);
    const samples = new Map<number, number>();
    for (let d = today - 30; d <= today; d++) samples.set(d, d === today ? 1000 : 10);
    const b = baselineFromSamples(samples, NOW, 30);
    expect(b.mu).toBe(10);
    expect(b.sigma).toBe(0);
  });

  it("z floors sigma and clamps to ±4", () => {
    // σ floor = max(1, 0.1μ) = 1 when μ = 10 and σ = 0 → z = (12 − 10)/1
    expect(zScore(12, { mu: 10, sigma: 0, nDays: 30 }, 4, 1, 0.1)).toBe(2);
    expect(zScore(1e9, base, 4, 1, 0.1)).toBe(4);
  });

  it("short history shrinks toward the cohort", () => {
    const s = shrinkToCohort({ mu: 20, sigma: 4, nDays: 7 }, { mu: 10, sigma: 2, nDays: 30 }, 14);
    expect(s.mu).toBeCloseTo((7 * 20 + 14 * 10) / 21);
  });

  it("degraded z holds 30 min then halves every 2h", () => {
    expect(degradedZ(2, 0, 29 * 60_000, 30, 2)).toBe(2);
    expect(degradedZ(2, 0, 30 * 60_000 + 2 * 3_600_000, 30, 2)).toBeCloseTo(1);
  });
});

describe("computeIndex", () => {
  it("everything at baseline → 100 / 100 / 100", () => {
    const r = computeIndex(allNormal(), DEFAULT_PARAMS, NOW);
    expect(r.scaled).toEqual({ b: 1_000_000, h: 1_000_000, w: 1_000_000 });
    expect(r.stopped).toBe(false);
  });

  it("golden: a release spike moves WORK and the blend", () => {
    const s = allNormal();
    s.releases = healthy(18); // z = 4 (clamped)
    const r = computeIndex(s, DEFAULT_PARAMS, NOW);
    // W = sq(0.35 × 4) = sq(1.4)
    const W = 2 / (1 + Math.exp(-1.4));
    expect(r.w).toBeCloseTo(100 * W, 10);
    expect(r.h).toBe(100);
    expect(r.b).toBeCloseTo(100 * (0.35 + 0.65 * W), 10);
    expect(r.scaled.w).toBe(Math.round(100 * W * 1e4));
  });

  it("unverified WORK sources count at 0.6", () => {
    const s = allNormal();
    s.commits = healthy(18, false);
    const r = computeIndex(s, DEFAULT_PARAMS, NOW);
    expect(r.w).toBeCloseTo(100 * squash(0.4 * 0.6 * 4), 10);
  });

  it("stops the Bloke when two sources in one leg are degraded", () => {
    const s = allNormal();
    s.x = { ...healthy(10), degradedSinceMs: NOW - 60_000, lastZ: 1 };
    expect(computeIndex(s, DEFAULT_PARAMS, NOW).stopped).toBe(false);
    s.reddit = { ...healthy(10), degradedSinceMs: NOW - 60_000, lastZ: 1 };
    const r = computeIndex(s, DEFAULT_PARAMS, NOW);
    expect(r.stopped).toBe(true);
    expect(r.stopReason).toMatch(/^hype/);
  });

  it("disabled optional sources renormalise the leg", () => {
    const p: IndexParams = structuredClone(DEFAULT_PARAMS);
    p.sources.reddit.enabled = false;
    p.sources.search.enabled = false;
    p.sources.hn.enabled = false;
    validateParams(p);
    expect(legWeights(p, "hype").get("x")).toBe(1);
    const s = allNormal();
    s.x = healthy(14); // z = 2
    expect(computeIndex(s, p, NOW).h).toBeCloseTo(100 * squash(2), 10);
    // With only X enabled, X going degraded alone stops the Bloke.
    s.x = { ...healthy(10), degradedSinceMs: NOW, lastZ: 0 };
    expect(computeIndex(s, p, NOW).stopped).toBe(true);
  });

  it("per-Bloke params drop the sources a Bloke has no account on (A16)", () => {
    const p = paramsForSources(DEFAULT_PARAMS, new Set(["hn", "onchain"] as const));
    expect(legWeights(p, "hype")).toEqual(new Map([["hn", 1]]));
    expect(legWeights(p, "work")).toEqual(new Map([["onchain", 1]]));
    expect(computable(p)).toBe(true);
    expect(computable(paramsForSources(DEFAULT_PARAMS, new Set(["hn"] as const)))).toBe(false);
    const s = { hn: healthy(14), onchain: healthy(10) };
    const r = computeIndex(s, p, NOW);
    expect(r.stopped).toBe(false);
    expect(r.h).toBeCloseTo(100 * squash(2), 10);
    expect(r.w).toBeCloseTo(100, 10);
  });

  it("paramsVersion is stable and sensitive", () => {
    const v = paramsVersion(DEFAULT_PARAMS);
    expect(v).toBe(paramsVersion(structuredClone(DEFAULT_PARAMS)));
    const p = structuredClone(DEFAULT_PARAMS);
    p.alpha = 0.4;
    expect(paramsVersion(p)).not.toBe(v);
  });

  it("validateParams rejects out-of-bounds values", () => {
    const p = structuredClone(DEFAULT_PARAMS);
    p.alpha = 0.95;
    expect(() => validateParams(p)).toThrow(/alpha/);
  });
});

describe("hype filters", () => {
  const old = NOW - 400 * DAY_MS;
  const m = (id: string, author: string, text: string, followers = 1000, created = old) => ({
    id,
    authorId: author,
    authorCreatedMs: created,
    followers,
    text,
    tMs: NOW - Number(id) * 1000,
  });

  it("drops young and low-follower accounts, weights by followers", () => {
    const r = filterXMentions(
      [m("1", "a", "shipping the new monad indexer today"), m("2", "b", "gm", 10), m("3", "c", "hello world", 1000, NOW - 10 * DAY_MS)],
      NOW,
    );
    expect(r.accepted.map((a) => a.id)).toEqual(["1"]);
    expect(r.accepted[0]!.value).toBeCloseTo(Math.log10(1001) / 4);
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(["author_followers", "author_young"]);
  });

  it("caps each author at 3 per day and collapses near-duplicates", () => {
    const texts = ["one thing about rust lifetimes", "a different take on solidity gas", "monad parallel execution is fast", "fourth post entirely new topic here"];
    const r1 = filterXMentions(texts.map((t, i) => m(String(i + 1), "a", t)), NOW);
    expect(r1.accepted).toHaveLength(3);
    const spam = "check out @alice she is the best dev on monad right now";
    const r2 = filterXMentions([m("1", "a", spam), m("2", "b", spam + "!!"), m("3", "c", spam)], NOW);
    expect(r2.accepted).toHaveLength(1);
  });

  it("caps any one subreddit at 40%", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, authorAgeDays: 100, authorKarma: 500, subreddit: "monad", score: 99, tMs: NOW })),
      { id: "b", authorAgeDays: 100, authorKarma: 500, subreddit: "ethdev", score: 99, tMs: NOW },
      { id: "c", authorAgeDays: 100, authorKarma: 500, subreddit: "rust", score: 99, tMs: NOW },
    ];
    const r = filterReddit(items);
    const total = r.accepted.reduce((a, x) => a + x.value, 0);
    const monad = r.accepted.filter((x) => x.id.startsWith("a")).reduce((a, x) => a + x.value, 0);
    expect(monad / total).toBeCloseTo(0.4, 10);
  });

  it("brigade guard excludes hours dominated by young accounts", () => {
    const hour = Array.from({ length: 20 }, (_, i) => ({ id: String(i), authorAgeDays: i < 13 ? 5 : 400 }));
    expect(brigadeCheck(hour).excluded).toBe(true);
    expect(brigadeCheck(hour.slice(10)).excluded).toBe(false);
  });
});

describe("work filters", () => {
  const c = (over: Partial<Parameters<typeof filterCommits>[0][number]>) => ({
    sha: Math.random().toString(16),
    patchId: Math.random().toString(16),
    repoStars: 10,
    repoOtherContributors: 0,
    changedLines: 20,
    whitespaceOnly: false,
    authorLogin: "alice",
    authorIsBot: false,
    isMergedPr: false,
    tMs: NOW,
    ...over,
  });

  it("drops spam commits and caps at 50 per day", () => {
    const r = filterCommits([
      c({ sha: "small", repoStars: 1 }),
      c({ sha: "tiny", changedLines: 2 }),
      c({ sha: "ws", whitespaceOnly: true }),
      c({ sha: "bot", authorLogin: "dependabot[bot]" }),
      c({ sha: "p1", patchId: "same" }),
      c({ sha: "p2", patchId: "same" }),
    ]);
    expect(r.accepted.map((x) => x.sha)).toEqual(["p1"]);
    const many = filterCommits(Array.from({ length: 60 }, (_, i) => c({ sha: `s${i}` })));
    expect(many.accepted).toHaveLength(50);
  });

  it("publishes need a version bump", () => {
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(publishQualifies({ registry: "npm", name: "x", version: "1.0.1", previousVersion: "1.0.0", tMs: NOW })).toBe(true);
    expect(publishQualifies({ registry: "npm", name: "x", version: "1.0.0", previousVersion: "1.0.0", tMs: NOW })).toBe(false);
  });

  it("self-calls from linked wallets earn nothing", () => {
    const day = Math.floor(NOW / DAY_MS);
    const counts = distinctExternalCallers(
      [
        { caller: "0xAAA", tMs: NOW },
        { caller: "0xaaa", tMs: NOW },
        { caller: "0xBBB", tMs: NOW },
        { caller: "0xSELF", tMs: NOW },
      ],
      new Set(["0xself"]),
    );
    expect(counts.get(day)).toBe(2);
  });
});

describe("rep (amendment A6)", () => {
  const close = (net: number, b: number, blokeId = 1, contrarian = false) => ({ wallet: "0xW", blokeId, net, b, contrarian, closedAtMs: NOW });

  it("a hedged pair earns no more than its net × 3", () => {
    const pts = earlyPoints([close(100, 3), close(-95, 1)]).get("0xw")!;
    expect(pts).toBeCloseTo(15); // 5 × 3, not 205 under the original rule
  });

  it("a losing day earns its net with no multiplier", () => {
    expect(earlyPoints([close(50, 3), close(-80, 1)]).get("0xw")).toBe(-30);
  });

  it("different Blokes are netted separately", () => {
    expect(earlyPoints([close(100, 2, 1), close(-50, 1, 2)]).get("0xw")).toBe(150);
  });

  it("earliness multiplier: chasers get 1×, early-and-right up to 3×", () => {
    expect(earlinessMultiplier({ side: 1, indexEntry: 105, indexEntryMinus10m: 100, indexClose: 120, sigmaEntry: 2 })).toBe(1);
    expect(earlinessMultiplier({ side: 1, indexEntry: 100, indexEntryMinus10m: 100, indexClose: 102, sigmaEntry: 2 })).toBe(2);
    expect(earlinessMultiplier({ side: -1, indexEntry: 100, indexEntryMinus10m: 100, indexClose: 80, sigmaEntry: 2 })).toBe(3);
  });
});
