/** WORK-leg spam filters (PRD §4.3). */

const DAY_MS = 86_400_000;

export interface Commit {
  sha: string;
  /** Stable patch id: identical diffs (force-push duplicates, cherry-picks) share it. */
  patchId: string;
  repoStars: number;
  repoOtherContributors: number;
  changedLines: number;
  whitespaceOnly: boolean;
  authorLogin: string;
  authorIsBot: boolean;
  isMergedPr: boolean;
  tMs: number;
}

export type CommitDropReason = "repo_too_small" | "tiny_diff" | "whitespace" | "bot" | "duplicate_patch" | "daily_cap";

export const COMMIT_RULES = { minStars: 5, minOtherContributors: 1, minChangedLines: 3, dailyCap: 50 };

export function isBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login) || /^(dependabot|renovate|github-actions)(\b|-)/i.test(login);
}

export function filterCommits(commits: readonly Commit[]): { accepted: Commit[]; dropped: { sha: string; reason: CommitDropReason }[] } {
  const sorted = [...commits].sort((a, b) => a.tMs - b.tMs || a.sha.localeCompare(b.sha));
  const accepted: Commit[] = [];
  const dropped: { sha: string; reason: CommitDropReason }[] = [];
  const seenPatch = new Set<string>();
  const perDay = new Map<number, number>();
  for (const c of sorted) {
    let reason: CommitDropReason | undefined;
    if (c.repoStars < COMMIT_RULES.minStars && c.repoOtherContributors < COMMIT_RULES.minOtherContributors) reason = "repo_too_small";
    else if (c.authorIsBot || isBotLogin(c.authorLogin)) reason = "bot";
    else if (c.whitespaceOnly) reason = "whitespace";
    else if (c.changedLines < COMMIT_RULES.minChangedLines) reason = "tiny_diff";
    else if (seenPatch.has(c.patchId)) reason = "duplicate_patch";
    else {
      const day = Math.floor(c.tMs / DAY_MS);
      const n = perDay.get(day) ?? 0;
      if (n >= COMMIT_RULES.dailyCap) reason = "daily_cap";
      else perDay.set(day, n + 1);
    }
    if (reason) dropped.push({ sha: c.sha, reason });
    else {
      seenPatch.add(c.patchId);
      accepted.push(c);
    }
  }
  return { accepted, dropped };
}

export interface Release {
  id: string;
  tag: string | null;
  notes: string;
  changedFilesSincePrevious: number;
  tMs: number;
}

export function releaseQualifies(r: Release): boolean {
  return !!r.tag && r.notes.trim().length > 0 && r.changedFilesSincePrevious >= 1;
}

export interface PackagePublish {
  registry: "npm" | "crates" | "pypi";
  name: string;
  version: string;
  previousVersion: string | null;
  tMs: number;
}

/** A publish counts only when it bumps the version above the previous one. */
export function publishQualifies(p: PackagePublish): boolean {
  if (p.previousVersion === null) return true;
  return compareSemver(p.version, p.previousVersion) > 0;
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((x) => Number.parseInt(x, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1; // release > prerelease
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * On-chain usage: distinct external callers of contracts deployed by linked addresses, excluding
 * callers that are themselves linked to the Bloke. Returns the count per UTC day.
 */
export function distinctExternalCallers(
  calls: readonly { caller: string; tMs: number }[],
  linked: ReadonlySet<string>,
): Map<number, number> {
  const linkedLc = new Set([...linked].map((a) => a.toLowerCase()));
  const perDay = new Map<number, Set<string>>();
  for (const c of calls) {
    const caller = c.caller.toLowerCase();
    if (linkedLc.has(caller)) continue;
    const day = Math.floor(c.tMs / DAY_MS);
    let set = perDay.get(day);
    if (!set) perDay.set(day, (set = new Set()));
    set.add(caller);
  }
  return new Map([...perDay].map(([d, s]) => [d, s.size]));
}
