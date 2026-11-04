import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { Redis } from "ioredis";
import { STREAM_CHANNEL, type StreamEvent } from "@bloke/shared";
import type { Ctx } from "./context.js";

const CHANNEL_RE = /^(index:[A-Z0-9]{2,10}|orders:0x[0-9a-f]{40}|feed|status|blokes|epochs)$/;
const MAX_CHANNELS = 50;

/**
 * Maps one committed event to the channels it belongs on (PRD §13.4). Pure, so routing is tested
 * without sockets.
 */
export function channelsFor(e: StreamEvent, tickerOf: (id: number) => string | undefined): string[] {
  switch (e.type) {
    case "index": {
      const t = tickerOf(e.blokeId);
      return t ? [`index:${t}`] : [];
    }
    case "push":
      return ["status"];
    case "order":
      return [`orders:${e.owner.toLowerCase()}`, ...(e.status === "filled" ? ["feed"] : [])];
    case "lot":
      return [`orders:${e.owner.toLowerCase()}`, "feed"];
    case "bloke":
      return ["blokes"];
    case "epoch":
      return ["epochs"];
    default:
      return [];
  }
}

/**
 * One Redis subscriber per instance; each instance fans out to its own sockets. Adding instances
 * behind a load balancer needs no coordination (PRD §13.1: API is stateless, horizontally scaled).
 */
export function registerStream(app: FastifyInstance, ctx: Ctx) {
  const sockets = new Map<WebSocket, Set<string>>();
  const tickers = new Map<number, string>();
  const tickerOf = (id: number) => tickers.get(id);
  const refreshTickers = async () => {
    const r = await ctx.db.query<{ id: number; ticker: string }>(`SELECT id, ticker FROM blokes`);
    for (const row of r.rows) tickers.set(row.id, row.ticker);
  };

  const sub = new Redis(ctx.env.REDIS_URL, { maxRetriesPerRequest: null });
  sub.subscribe(STREAM_CHANNEL).catch((err) => app.log.error({ err }, "stream subscribe failed"));
  sub.on("message", async (_ch: string, raw: string) => {
    let e: StreamEvent;
    try {
      e = JSON.parse(raw) as StreamEvent;
    } catch {
      return;
    }
    if (e.type === "index" && !tickers.has(e.blokeId)) await refreshTickers().catch(() => undefined);
    if (e.type === "bloke") await refreshTickers().catch(() => undefined);
    const chans = channelsFor(e, tickerOf);
    if (!chans.length) return;
    const ticker = e.type === "index" ? tickerOf(e.blokeId) : undefined;
    for (const [ws, subs] of sockets) {
      for (const c of chans) {
        if (subs.has(c) && ws.readyState === 1) ws.send(JSON.stringify({ channel: c, event: ticker ? { ...e, ticker } : e }));
      }
    }
  });

  app.get("/v1/stream", { websocket: true }, (socket: WebSocket) => {
    const subs = new Set<string>();
    sockets.set(socket, subs);
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);
    socket.on("pong", () => (alive = true));
    socket.on("message", (data: Buffer) => {
      let m: { op?: string; channels?: unknown };
      try {
        m = JSON.parse(data.toString());
      } catch {
        return socket.send(JSON.stringify({ op: "error", message: "invalid JSON" }));
      }
      const chans = Array.isArray(m.channels) ? m.channels.filter((c): c is string => typeof c === "string") : [];
      const bad = chans.filter((c) => !CHANNEL_RE.test(c));
      if (bad.length) return socket.send(JSON.stringify({ op: "error", message: `unknown channels: ${bad.join(", ")}` }));
      if (m.op === "subscribe") {
        for (const c of chans) if (subs.size < MAX_CHANNELS) subs.add(c);
      } else if (m.op === "unsubscribe") {
        for (const c of chans) subs.delete(c);
      } else {
        return socket.send(JSON.stringify({ op: "error", message: "op must be subscribe or unsubscribe" }));
      }
      socket.send(JSON.stringify({ op: "subscribed", channels: [...subs] }));
    });
    socket.on("close", () => {
      clearInterval(ping);
      sockets.delete(socket);
    });
  });

  app.addHook("onClose", async () => {
    sub.disconnect();
    for (const ws of sockets.keys()) ws.terminate();
  });
}
