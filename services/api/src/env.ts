import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

/** Every setting the API reads, validated once at start-up. */
export const EnvSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  RPC_URL: z.string().min(1),
  RPC_URLS: z.string().optional(),
  ADDRESSES: z.string().min(1),

  /** Signs faucet, claim and source attestations. KMS-backed in the event environment (PRD §13.2). */
  ATTESTER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Pays gas for relayed faucet claims and MON drips. Its own key: never shared with the pusher. */
  FAUCET_RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Staging only: a LISTER key for self-serve listings behind "Start your raise" (A18). */
  LISTER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  DRIP_MON: z.coerce.number().default(0.5),

  /** SIWE (EIP-4361): the frontend's host and URL the wallet sees in the message. */
  SIWE_DOMAIN: z.string().default("localhost:3000"),
  SIWE_URI: z.string().default("http://localhost:3000"),
  SESSION_TTL_SEC: z.coerce.number().default(24 * 3600),
  COOKIE_SECURE: bool,
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  /** Provider endpoints; overridden only by the integration suite's mock OAuth server. */
  GITHUB_AUTHORIZE_URL: z.string().default("https://github.com/login/oauth/authorize"),
  GITHUB_TOKEN_URL: z.string().default("https://github.com/login/oauth/access_token"),
  GITHUB_API_URL: z.string().default("https://api.github.com"),
  X_AUTHORIZE_URL: z.string().default("https://x.com/i/oauth2/authorize"),
  X_TOKEN_URL: z.string().default("https://api.x.com/2/oauth2/token"),
  X_API_URL: z.string().default("https://api.x.com/2"),
  /** Staging/local only: enables the `test` identity provider used by the integration suite. */
  ALLOW_TEST_IDENTITY: bool,

  ADMIN_API_TOKEN: z.string().min(16).optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(60),
  ATTESTATIONS_PER_HOUR: z.coerce.number().default(10),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid API environment: ${issues}`);
  }
  return r.data;
}
