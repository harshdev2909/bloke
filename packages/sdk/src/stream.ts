import type { StreamEvent } from "@bloke/shared";

export type { StreamEvent };

/**
 * Channels (PRD §13.4): `index:{TICKER}`, `orders:{wallet}` (lowercase address), `feed` (every fill
 * and close), `status` (oracle pushes), `blokes` (status changes).
 */
export type Channel = `index:${string}` | `orders:${string}` | "feed" | "status" | "blokes" | "epochs";

export interface StreamMessage {
  channel: Channel;
  event: StreamEvent & { ticker?: string };
}

type Listener = (m: StreamMessage) => void;

export interface StreamOptions {
  url: string; // ws(s)://host/v1/stream
  WebSocket?: typeof WebSocket;
  /** Reconnect backoff cap in ms. */
  maxBackoffMs?: number;
}

/** Reconnecting WebSocket client; re-subscribes to every channel after a reconnect. */
export class BlokeStream {
  private ws: WebSocket | undefined;
  private readonly channels = new Set<Channel>();
  private readonly listeners = new Set<Listener>();
  private backoff = 250;
  private closed = false;
  private readonly WS: typeof WebSocket;

  constructor(private readonly opts: StreamOptions) {
    this.WS = opts.WebSocket ?? WebSocket;
    this.connect();
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribe(...channels: Channel[]) {
    for (const c of channels) this.channels.add(c);
    this.send({ op: "subscribe", channels });
  }

  unsubscribe(...channels: Channel[]) {
    for (const c of channels) this.channels.delete(c);
    this.send({ op: "unsubscribe", channels });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private connect() {
    const ws = new this.WS(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 250;
      if (this.channels.size) this.send({ op: "subscribe", channels: [...this.channels] });
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data)) as StreamMessage | { op: string };
        if ("channel" in m) for (const l of this.listeners) l(m);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 10_000);
    };
  }
}
