/**
 * Archetypes: what kind of work a Bloke is priced on. Each one names the signal sources its legs
 * lean on and the verification paths BLOKE actually runs for it (OAuth ids, attested signatures,
 * Skin). Set by the operator at listing; otherwise derived from the Bloke's sources.
 */
export type SourceKind = "x" | "reddit" | "search" | "hn" | "commits" | "releases" | "onchain";

export type ArchetypeId = "creator" | "builder" | "scholar" | "trader" | "founder" | "voice";

export type Verification = "github" | "x" | "deployer" | "wallet" | "skin";

export interface Archetype {
  id: ArchetypeId;
  numeral: string;
  figure: string;
  domain: string;
  role: string;
  line: string;
  hype: SourceKind[];
  work: SourceKind[];
  verifiedWith: Verification[];
}

export const ARCHETYPES: readonly Archetype[] = [
  { id: "creator", numeral: "I", figure: "Apollo", domain: "Music & art", role: "The Creator", line: "Makes what people play, watch and read.", hype: ["x", "search"], work: ["releases"], verifiedWith: ["x", "wallet"] },
  { id: "builder", numeral: "II", figure: "Herakles", domain: "Engineering", role: "The Builder", line: "Ships code other people run.", hype: ["x", "hn"], work: ["commits", "releases", "onchain"], verifiedWith: ["github", "deployer"] },
  { id: "scholar", numeral: "III", figure: "Epikouros", domain: "Research", role: "The Scholar", line: "Publishes the ideas others build on.", hype: ["hn", "search", "reddit"], work: ["releases", "commits"], verifiedWith: ["github", "x"] },
  { id: "trader", numeral: "IV", figure: "Hermes", domain: "Markets", role: "The Trader", line: "Moves capital and makes markets.", hype: ["x"], work: ["onchain"], verifiedWith: ["deployer", "wallet"] },
  { id: "founder", numeral: "V", figure: "Augustus", domain: "Founders", role: "The Founder", line: "Builds the company around the product.", hype: ["x", "hn", "search"], work: ["commits", "onchain"], verifiedWith: ["github", "x", "skin"] },
  { id: "voice", numeral: "VI", figure: "Muse", domain: "Community & media", role: "The Voice", line: "Gathers the room and keeps it talking.", hype: ["x", "reddit", "search"], work: ["releases"], verifiedWith: ["x"] },
] as const;

export const ARCHETYPE_IDS = ARCHETYPES.map((a) => a.id) as ArchetypeId[];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  x: "X posts",
  reddit: "Reddit",
  search: "Search interest",
  hn: "Hacker News",
  commits: "GitHub commits",
  releases: "Releases",
  onchain: "On-chain activity",
};

export const VERIFICATION_LABEL: Record<Verification, string> = {
  github: "GitHub sign-in",
  x: "X sign-in",
  deployer: "Deployer signature",
  wallet: "Claimed wallet",
  skin: "Skin in the pool",
};

/**
 * Best-fit archetype for a set of source kinds (used when the operator hasn't set one): the
 * archetype whose sources overlap most, ties broken by catalogue order. Null without sources.
 */
export function deriveArchetype(kinds: readonly SourceKind[]): ArchetypeId | null {
  if (!kinds.length) return null;
  const have = new Set(kinds);
  let best: ArchetypeId | null = null;
  let bestScore = 0;
  for (const a of ARCHETYPES) {
    // WORK sources say more about the kind of work than attention sources do.
    const score = a.work.filter((k) => have.has(k)).length * 2 + a.hype.filter((k) => have.has(k)).length;
    if (score > bestScore) [best, bestScore] = [a.id, score];
  }
  return best;
}
