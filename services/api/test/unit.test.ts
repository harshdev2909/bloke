import { describe, expect, it } from "vitest";
import { concat, keccak256, pad, toHex } from "viem";
import { linkedHash } from "../src/attester.js";
import { identityHash, qualifies } from "../src/identity.js";
import { channelsFor } from "../src/stream.js";
import { EnvSchema } from "../src/env.js";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 4);

describe("identity rules (amendment A8)", () => {
  it("GitHub qualifies at 30 days; X needs 90 days and 10 followers", () => {
    const gh = (days: number) => ({ provider: "github" as const, externalId: "1", handle: null, createdAt: new Date(now - days * DAY), followers: 0 });
    expect(qualifies(gh(29), now)).toBe(false);
    expect(qualifies(gh(30), now)).toBe(true);
    const x = (days: number, followers: number) => ({ provider: "x" as const, externalId: "1", handle: null, createdAt: new Date(now - days * DAY), followers });
    expect(qualifies(x(120, 9), now)).toBe(false);
    expect(qualifies(x(89, 500), now)).toBe(false);
    expect(qualifies(x(90, 10), now)).toBe(true);
  });

  it("identity hash matches the faucet's convention keccak256('provider:id')", () => {
    expect(identityHash("github", "12345")).toBe(keccak256(toHex("github:12345")));
  });
});

describe("attestations", () => {
  it("linkedHash pads each address to 32 bytes like abi.encodePacked(address[])", () => {
    const a = "0x00000000000000000000000000000000000000a1";
    const b = "0x00000000000000000000000000000000000000b2";
    expect(linkedHash([a, b])).toBe(keccak256(concat([pad(a, { size: 32 }), pad(b, { size: 32 })])));
    expect(linkedHash([])).toBe(keccak256("0x"));
  });
});

describe("stream routing", () => {
  const tickers = (id: number) => (id === 1 ? "FOUNDER" : undefined);
  const owner = "0x00000000000000000000000000000000000000AB";
  it("routes each event type to its channels", () => {
    expect(channelsFor({ type: "index", blokeId: 1, b: 1, h: 1, w: 1, lagFlags: 0, seq: "1", tsMs: "1" }, tickers)).toEqual(["index:FOUNDER"]);
    expect(channelsFor({ type: "index", blokeId: 9, b: 1, h: 1, w: 1, lagFlags: 0, seq: "1", tsMs: "1" }, tickers)).toEqual([]);
    expect(channelsFor({ type: "order", owner, orderId: "1", status: "requested", txHash: "0x1" }, tickers)).toEqual([`orders:${owner.toLowerCase()}`]);
    expect(channelsFor({ type: "order", owner, orderId: "1", status: "filled", txHash: "0x1" }, tickers)).toEqual([`orders:${owner.toLowerCase()}`, "feed"]);
    expect(channelsFor({ type: "push", seq: "1", tsMs: "1", entries: 2 }, tickers)).toEqual(["status"]);
    expect(channelsFor({ type: "bloke", blokeId: 1, status: "live" }, tickers)).toEqual(["blokes"]);
  });
});

describe("env", () => {
  it("rejects malformed keys and applies defaults", () => {
    const base = { DATABASE_URL: "postgres://x", RPC_URL: "http://x", ADDRESSES: "a.json", ATTESTER_PRIVATE_KEY: `0x${"1".repeat(64)}`, FAUCET_RELAYER_PRIVATE_KEY: `0x${"2".repeat(64)}` };
    const ok = EnvSchema.parse(base);
    expect(ok.PORT).toBe(8080);
    expect(ok.ALLOW_TEST_IDENTITY).toBe(false);
    expect(() => EnvSchema.parse({ ...base, ATTESTER_PRIVATE_KEY: "0x12" })).toThrow();
  });
});
