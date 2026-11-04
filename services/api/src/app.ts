import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { registerAuth } from "./auth.js";
import type { Ctx } from "./context.js";
import { jsonReplacer, sendError } from "./http.js";
import { registerIdentity } from "./identity.js";
import { registerActions } from "./routes/actions.js";
import { registerReads } from "./routes/reads.js";
import { registerGraduationReads } from "./routes/graduations.js";
import { registerRaiseReads } from "./routes/raises.js";
import { registerPow } from "./routes/pow.js";
import { registerStream } from "./stream.js";

export interface AppOptions {
  /** Injected for OAuth tests. */
  fetch?: typeof fetch;
  logger?: boolean;
}

export async function buildApp(ctx: Ctx, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });
  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));
  app.setErrorHandler(sendError);

  const origins = ctx.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, { origin: origins, credentials: true });
  await app.register(cookie);
  // 60 requests/minute/IP shared across instances via Redis (PRD §13.4).
  await app.register(rateLimit, {
    max: ctx.env.RATE_LIMIT_PER_MIN,
    timeWindow: "1 minute",
    redis: ctx.redis,
    nameSpace: "rl:",
    allowList: (req) => req.url === "/healthz",
    errorResponseBuilder: () => ({ statusCode: 429, error: "rate_limited", message: "Too many requests. Slow down." }),
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.get("/healthz", async () => {
    await Promise.all([ctx.db.query("SELECT 1"), ctx.redis.ping()]);
    return { ok: true };
  });

  registerAuth(app, ctx);
  registerIdentity(app, ctx, opts.fetch);
  registerReads(app, ctx);
  registerGraduationReads(app, ctx);
  registerRaiseReads(app, ctx);
  registerPow(app, ctx);
  registerActions(app, ctx);
  registerStream(app, ctx);
  return app;
}
