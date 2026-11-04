import type { Redis } from "ioredis";
import { type IndexSource, type IndexTick, SYNTHETIC_PARAMS_VERSION } from "@bloke/index-core";

/**
 * Ticks published by index-compute (Redis hash `index:ticks`, one JSON entry per Bloke). The pusher
 * reads synchronously each tick, so a background refresh keeps an in-memory copy. A tick older than
 * `staleMs` (index-compute down or stuck) is reported as stopped: the oracle then goes stale and
 * trading pauses, rather than repeating an old value as if it were fresh.
 */
export class RedisIndexSource implements IndexSource {
  private ticks: (IndexTick & { tsMs: number; paramsVersion: `0x${string}` })[] = [];
  private version: `0x${string}` = SYNTHETIC_PARAMS_VERSION;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly staleMs = 90_000,
  ) {}

  async start(refreshMs = 1000): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch(() => {}), refreshMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    const [all, version] = await Promise.all([this.redis.hgetall("index:ticks"), this.redis.get("index:params_version")]);
    this.ticks = Object.values(all).map((v) => JSON.parse(v));
    if (version) this.version = version as `0x${string}`;
  }

  paramsVersion(): `0x${string}` {
    return this.version;
  }

  latest(nowMs: number): IndexTick[] {
    return this.ticks
      .map((t) => ({ blokeId: t.blokeId, b: t.b, h: t.h, w: t.w, stopped: t.stopped || nowMs - t.tsMs > this.staleMs }))
      .sort((a, b) => a.blokeId - b.blokeId);
  }
}
