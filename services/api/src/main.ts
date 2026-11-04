import { buildApp } from "./app.js";
import { closeCtx, createCtx } from "./context.js";
import { loadEnv } from "./env.js";

/** Stateless HTTP + WebSocket API (PRD §13.4). Run as many replicas as needed behind a load balancer. */
async function main() {
  const env = loadEnv();
  const ctx = await createCtx(env);
  const app = await buildApp(ctx, { logger: true });
  const shutdown = async () => {
    await app.close();
    await closeCtx(ctx);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
