import type { FastifyReply, FastifyRequest } from "fastify";
import type { Meta, Source } from "@bloke/sdk";

/** Error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string) => new HttpError(400, code, msg);
export const unauthorized = (msg = "Sign in first.") => new HttpError(401, "unauthorized", msg);
export const forbidden = (code: string, msg: string) => new HttpError(403, code, msg);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg: string) => new HttpError(409, code, msg);
export const tooMany = (code: string, msg: string) => new HttpError(429, code, msg);

export function meta(sources: Record<string, Source>, block?: bigint): Meta {
  return { sources, ...(block !== undefined && { block: block.toString() }) };
}

/** bigint-safe JSON: amounts are serialised as decimal strings. */
export function jsonReplacer(_: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

export function sendError(err: unknown, _req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
  const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
  if (e.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Too many requests. Slow down." });
  if (e.validation || e.code === "FST_ERR_VALIDATION") return reply.status(400).send({ error: "invalid_request", message: e.message ?? "invalid" });
  if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "error" });
  _req.log.error(err);
  return reply.status(500).send({ error: "internal", message: "Something went wrong." });
}

export const hexToBuf = (h: string) => Buffer.from(h.replace(/^0x/, ""), "hex");
export const bufToHex = (b: Buffer | null | undefined) => (b ? (`0x${b.toString("hex")}` as `0x${string}`) : null);
