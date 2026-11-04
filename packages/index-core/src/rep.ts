/**
 * Rep "early" points (PRD §11, amendment A6).
 *
 * Original rule: winning closes earn net × b (b ∈ [1, 3]); a day whose net across one Bloke's three
 * markets is ≤ 0 earns net with no multiplier. That still pays hedged pairs whenever the day nets
 * slightly positive (+100 × 3 − 95 = 205 points from 5 of PnL).
 *
 * Amended rule: per wallet, Bloke and UTC day, points = dayNet × b̄ when dayNet > 0, where b̄ is the
 * |pnl|-weighted mean multiplier of that day's winning closes; otherwise points = dayNet. A hedged
 * pair therefore earns at most (small net) × 3, never more than a plain trade with the same PnL.
 */

const DAY_MS = 86_400_000;

export interface Close {
  wallet: string;
  blokeId: number;
  /** Net PnL after fee, in tUSDC. */
  net: number;
  /** Earliness multiplier for this lot, in [1, 3]. */
  b: number;
  /** Contrarian bonus applies (+25% of early points on a winning close). */
  contrarian: boolean;
  closedAtMs: number;
}

export interface Earliness {
  side: 1 | -1;
  indexEntry: number;
  indexEntryMinus10m: number;
  indexClose: number;
  /** σ of 1-minute samples over the 60 minutes before entry, floored at 0.5 index points. */
  sigmaEntry: number;
}

export function earlinessMultiplier(e: Earliness): number {
  const sigma = Math.max(0.5, e.sigmaEntry);
  const chased = e.side * (e.indexEntry - e.indexEntryMinus10m) > sigma;
  if (chased) return 1;
  return 1 + Math.max(0, Math.min(2, (e.side * (e.indexClose - e.indexEntry)) / sigma));
}

export function earlyPoints(closes: readonly Close[]): Map<string, number> {
  const groups = new Map<string, Close[]>();
  for (const c of closes) {
    const key = `${c.wallet.toLowerCase()}|${c.blokeId}|${Math.floor(c.closedAtMs / DAY_MS)}`;
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const totals = new Map<string, number>();
  for (const [key, group] of groups) {
    const wallet = key.split("|")[0]!;
    const dayNet = group.reduce((a, c) => a + c.net, 0);
    let pts: number;
    if (dayNet <= 0) {
      pts = dayNet;
    } else {
      const winners = group.filter((c) => c.net > 0);
      const wSum = winners.reduce((a, c) => a + c.net, 0);
      const bBar = winners.reduce((a, c) => a + c.net * c.b, 0) / wSum;
      const contrarianShare = winners.filter((c) => c.contrarian).reduce((a, c) => a + c.net, 0) / wSum;
      pts = dayNet * bBar * (1 + 0.25 * contrarianShare);
    }
    totals.set(wallet, (totals.get(wallet) ?? 0) + pts);
  }
  return totals;
}

/** Season totals never go below 0. */
export function seasonTotal(early: number, backer: number, spotter: number): number {
  return Math.max(0, early + backer + spotter);
}
