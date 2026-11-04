import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, DAY_MS } from "@bloke/index-core";
import { type BlokeInput, computeAll, dailySamples, documentVersion, levelAt, modeFor, paramsDocument } from "../src/engine.js";

const NOW = Date.UTC(2026, 10, 4, 12);
const HOUR = 3_600_000;
const healthy = { okAtMs: NOW - 60_000, staleMs: 10 * 60_000 };

/** n events a day, one an hour from NOW's hour, for `days` days before NOW (the last day ends at NOW). */
function steady(days: number, perDay: number, value = 1) {
  const out = [];
  for (let d = 1; d <= days; d++) for (let i = 1; i <= perDay; i++) out.push({ tMs: NOW - d * DAY_MS + i * HOUR, value });
  return out;
}

describe("index-compute engine", () => {
  it("decays events with the source's time constant", () => {
    expect(levelAt([{ tMs: NOW - 6 * HOUR, value: 1 }], NOW, 6)).toBeCloseTo(Math.exp(-1), 12);
    expect(levelAt([{ tMs: NOW + HOUR, value: 1 }], NOW, 6)).toBe(0); // future events don't count yet
  });

  it("samples daily levels only after a source's first event", () => {
    const s = dailySamples([{ tMs: NOW - 3 * DAY_MS, value: 1 }], NOW, 30, 24);
    expect([...s.keys()].length).toBe(3);
  });

  it("a new source with no history and no cohort reads as neutral", () => {
    const input: BlokeInput = {
      blokeId: 3,
      sources: new Map([
        ["hn", { verified: false, health: healthy, points: [] }],
        ["onchain", { verified: true, health: healthy, points: [] }],
      ]),
    };
    const r = computeAll([input], DEFAULT_PARAMS, NOW).get(3)!;
    expect(r.z).toEqual({ hn: 0, onchain: 0 });
    expect(r.b).toBeCloseTo(100, 10);
    // ...and the first real activity moves it (the prior is zero activity, not the current level).
    input.sources.get("onchain")!.points = [{ tMs: NOW - 60_000, value: 2 }];
    expect(computeAll([input], DEFAULT_PARAMS, NOW).get(3)!.z.onchain).toBeGreaterThan(1.5);
  });

  it("uses signals when both legs have a source, synthetic otherwise", () => {
    expect(modeFor(DEFAULT_PARAMS, new Set(["hn", "onchain"])).mode.mode).toBe("signals");
    expect(modeFor(DEFAULT_PARAMS, new Set(["hn"])).mode.mode).toBe("synthetic");
    expect(modeFor(DEFAULT_PARAMS, new Set()).mode.mode).toBe("synthetic");
  });

  it("a Bloke at its usual pace sits near 100; a burst of work lifts WORK", () => {
    const base = (): BlokeInput => ({
      blokeId: 1,
      sources: new Map([
        // Activity spread evenly through each day, so the level does not depend on the time of day.
        ["hn", { verified: false, health: healthy, points: steady(30, 24, 0.1) }],
        ["commits", { verified: true, health: healthy, points: steady(30, 24, 0.2) }],
      ]),
    });
    const calm = computeAll([base()], DEFAULT_PARAMS, NOW).get(1)!;
    expect(calm.stopped).toBe(false);
    expect(calm.w).toBeGreaterThan(80);
    expect(calm.w).toBeLessThan(120);

    const busy = base();
    const c = busy.sources.get("commits")!;
    c.points = [...c.points, ...Array.from({ length: 40 }, (_, i) => ({ tMs: NOW - i * 60_000, value: 1 }))];
    const r = computeAll([busy], DEFAULT_PARAMS, NOW).get(1)!;
    expect(r.w).toBeGreaterThan(calm.w + 20);
    expect(r.h).toBeCloseTo(calm.h, 6);
  });

  it("a collector that stops succeeding degrades its source and stops a one-source leg", () => {
    const input: BlokeInput = {
      blokeId: 2,
      sources: new Map([
        ["hn", { verified: false, health: { okAtMs: NOW - 2 * HOUR, staleMs: 15 * 60_000 }, points: steady(10, 1) }],
        ["onchain", { verified: true, health: healthy, points: steady(10, 3) }],
      ]),
    };
    const r = computeAll([input], DEFAULT_PARAMS, NOW).get(2)!;
    expect(r.degraded).toEqual(["hn"]);
    expect(r.stopped).toBe(true);
  });

  it("the params document version changes when a Bloke changes mode", () => {
    const a = documentVersion(paramsDocument(DEFAULT_PARAMS, new Map([[1, { mode: "synthetic" as const }]])));
    const b = documentVersion(paramsDocument(DEFAULT_PARAMS, new Map([[1, modeFor(DEFAULT_PARAMS, new Set(["hn", "onchain"])).mode]])));
    expect(a).not.toBe(b);
    expect(a).toBe(documentVersion(paramsDocument(DEFAULT_PARAMS, new Map([[1, { mode: "synthetic" as const }]]))));
  });
});
