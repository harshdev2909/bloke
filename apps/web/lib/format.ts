/**
 * One place for every number on screen. Amounts arrive as decimal strings from the API (no float
 * rounding): tUSDC has 6 decimals, prices are 18-decimal WAD, index values are ×1e4.
 */

const USDC = 1_000_000n;
const WAD = 10n ** 18n;

function grouped(n: number, digits: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 12345678901 → "12,345.68" (tUSDC always 2 dp in a view, PRD consistency rule). */
export function usdc(raw: string | bigint | null | undefined, opts: { compact?: boolean; sign?: boolean } = {}): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  const n = Number(v) / Number(USDC);
  const s = opts.compact && Math.abs(n) >= 10_000 ? compact(n) : grouped(n, 2);
  return opts.sign && n > 0 ? `+${s}` : n < 0 ? `−${s.replace("-", "")}` : s;
}

/** WAD-denominated tUSDC (PnL, notional) → "1,234.56". */
export function wadUsdc(raw: string | bigint | null | undefined, opts: { sign?: boolean; compact?: boolean } = {}) {
  if (raw === null || raw === undefined) return "—";
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  return usdc(v / 10n ** 12n, opts);
}

/** WAD price → "101.37". */
export function price(raw: string | bigint | null | undefined, digits = 2): string {
  if (raw === null || raw === undefined) return "—";
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  return grouped(Number((v * 10_000n) / WAD) / 10_000, digits);
}

/** Index ×1e4 → "101.4". */
export function idx(raw: number | null | undefined, digits = 1): string {
  if (raw === null || raw === undefined) return "—";
  return grouped(raw / 10_000, digits);
}

/** Change in index points ×1e4 → "+1.2" / "−0.4". */
export function delta(raw: number | null | undefined, digits = 1): string {
  if (raw === null || raw === undefined) return "—";
  const v = raw / 10_000;
  if (Math.abs(v) < 0.05) return "0.0";
  return `${v > 0 ? "+" : "−"}${grouped(Math.abs(v), digits)}`;
}

/** WAD fraction → "+1.67%". */
export function pctWad(raw: string | bigint | null | undefined): string {
  if (raw === null || raw === undefined) return "—";
  const v = Number(typeof raw === "bigint" ? raw : BigInt(raw)) / 1e16;
  if (Math.abs(v) < 0.005) return "0.00%";
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function shortAddr(a: string | null | undefined) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

export function ago(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "1000.5" (user input) → 1000500000n micro-tUSDC, or null if invalid. */
export function parseUsdc(input: string): bigint | null {
  const s = input.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * USDC + BigInt((f + "000000").slice(0, 6));
}
