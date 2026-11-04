/**
 * API response types: the contract between services/api and the frontend. Amounts and prices are
 * decimal strings (no float rounding): tUSDC in 6-decimal units, prices in 18-decimal WAD, index
 * values ×1e4 (100.0 = 1000000). Every response says where each figure came from (PRD §14.6).
 */

import type { Archetype, ArchetypeId, SourceKind } from "@bloke/shared";

export type { Archetype, ArchetypeId };
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** "on-chain" = contract read, "indexed" = from events in Postgres, "computed" = off-chain job. */
export type Source = "on-chain" | "indexed" | "computed";

export interface Meta {
  /** Block the on-chain reads were taken at. */
  block?: string;
  sources: Record<string, Source>;
}

export interface Envelope<T> {
  data: T;
  meta: Meta;
}

export type Leg = "blend" | "hype" | "work";
export type BlokeStatus = "shadow" | "live" | "delist_pending" | "delisted" | "graduated";
export type MarketStatus = "None" | "Shadow" | "Live" | "ReduceOnly" | "Frozen" | "SettleOnly" | "Settled";

export interface IndexValues {
  b: number;
  h: number;
  w: number;
  tsMs: string;
  fresh: boolean;
  /** Bits per leg: 1 = raw above applied (catching up ↑), 2 = below (↓). */
  lagFlags: number;
}

export interface MarketSummary {
  marketId: number;
  leg: Leg;
  status: MarketStatus;
  /** Mark price (WAD). */
  mark: string;
  /** Premium (WAD fraction, signed). */
  premium: string;
  /** Net open interest in units (WAD, signed) and its notional at mark (WAD tUSDC). */
  netUnits: string;
  netNotional: string;
  grossCollateral: string;
  openLots: number;
}

export interface BlokeSummary {
  id: number;
  ticker: string;
  name: string;
  tier: number;
  status: BlokeStatus;
  claimed: boolean;
  index: IndexValues | null;
  /** 1 h change of the blended index, in index points ×1e4 (null without history). */
  change1h: number | null;
  /** "underrated" when WORK ≥ HYPE + 10 points, "overhyped" when HYPE ≥ WORK + 10. */
  badge: "underrated" | "overhyped" | null;
  /** Operator-set, or derived from the Bloke's sources; null when neither applies. */
  archetype: ArchetypeId | null;
}

export interface ArchetypeView extends Archetype {
  /** Blokes on the floor with this archetype. */
  blokes: number;
}

export interface BlokeDetail extends BlokeSummary {
  claimedWallet: Address | null;
  sources: { kind: string; handle: string | null; verified: boolean }[];
  markets: MarketSummary[];
  settlePrice: { b: number; h: number; w: number } | null;
  graduation: GraduationChecks;
}

export interface GraduationCheck {
  name: string;
  pass: boolean;
  value: string;
  threshold: string;
  /** False until the phase that provides this check ships (P2 Skin, P4 launcher/attester). */
  available: boolean;
}

export interface GraduationChecks {
  profile: "event" | "mainnet-intent" | "custom";
  checks: GraduationCheck[];
}

/** One source's contribution to a Bloke's index (P3, index-compute). */
export interface SignalRow {
  source: SourceKind;
  /** Clamped z-score against the Bloke's own 30-day baseline. */
  z: number;
  /** Effective weight within its leg after unavailable sources drop out (A16). */
  weight: number;
  degraded: boolean;
}

export interface SignalsEnvelope {
  data: SignalRow[];
  meta: Meta & { available: boolean; mode: "signals" | "synthetic" | null; stopped: boolean | null; at: string | null };
}

export interface IndexPoint {
  t: string; // ISO bucket start
  b: number;
  h: number;
  w: number;
}

export interface Trade {
  kind: "fill" | "close";
  orderId?: string;
  lotId: string;
  side: number;
  price: string;
  collateral?: string;
  payout?: string;
  at: string;
  txHash: Hex;
}

export interface Lot {
  lotId: string;
  marketId: number;
  blokeId: number;
  ticker: string;
  leg: Leg;
  side: 1 | -1;
  status: string;
  collateral: string;
  units: string;
  entryPrice: string;
  groupId: string | null;
  openedAt: string;
  /** Live values (on-chain lotView); only for open lots. */
  equity?: string;
  pricePnl?: string;
  fundingPnl?: string;
  exhausted?: boolean;
  close?: { exitPrice: string; pricePnl: string; fundingPnl: string; fee: string; payout: string; closedAt: string };
}

export interface Order {
  orderId: string;
  marketId: number;
  side: number;
  kind: "open" | "close" | "spread";
  collateral: string;
  status: "pending" | "filled" | "rejected" | "cancelled" | "expired" | "deferred";
  rejectReason: string | null;
  requestedAt: string;
  finalAt: string | null;
}

export interface WalletView {
  address: Address;
  tusdc: string;
  mon: string;
  claimable: string;
  iou: string;
  pendingCount: number;
  lots: Lot[];
  orders: Order[];
  rep: { season: number; total: number } | null;
  decks: DeckPosition;
  /** Profiles this wallet has claimed, with their Skin (PRD §9.4). */
  profiles: { blokeId: number; ticker: string; skin: string; hasSkin: boolean; skinSince: string | null }[];
}

export interface FloorSeriesView {
  id: number;
  rateBps: number;
  start: string;
  end: string;
  state: "subscribing" | "active" | "matured";
  subscribed: string;
  principal: string;
  value: string;
  token: Address;
}

export interface PoolView {
  phase: "P2-waterfall";
  /** E + R: backs every exposure cap. */
  capBase: string;
  floor: { value: string; active: FloorSeriesView | null; open: FloorSeriesView | null; paused: boolean };
  edge: { nav: string; totalShares: string; /** tUSDC (6 dp) per 1 EDGE; EDGE has 12 decimals. */ sharePrice: string; token: Address };
  reserve: string;
  treasury: string;
  subordinationBps: number;
  creditEvent: boolean;
  epoch: string;
  epochEndsAt: string;
  globalReduceOnly: boolean;
  globalNetAbs: string;
  hypeFamily: string;
  caps: { netCapMarketBps: number; netCapGlobalBps: number; netCapFamilyBps: number };
}

export interface EpochRow {
  n: string;
  g: string;
  fee: string;
  dReserve: string;
  dTreasury: string;
  floorAccrual: string;
  dEdge: string;
  skinAbsorbed: string;
  impairment: string;
  settledAt: string;
}

export interface DeckPosition {
  edgeShares: string;
  edgeValue: string;
  floor: { seriesId: number; shares: string; state: string }[];
  pendingEdge: { epoch: string; deposit: string; redeemShares: string; processed: boolean }[];
  subscriptions: { seriesId: number; amount: string; claimable: boolean }[];
}

/** A graduated Bloke's token, pool and allocations (PRD §10), read from chain. */
export interface GraduationView {
  graduated: boolean;
  token: Address | null;
  pair: Address | null;
  symbol: string | null;
  at: string | null;
  /** Spot price per token: tBLOKE (18 dp) from the pool, tUSDC (6 dp) via the desk. */
  price: { tbloke: string; usdc: string; deskUsdcPerTbloke: string } | null;
  reserves: { token: string; tbloke: string } | null;
  lock: { id: number; amount: string; unlockAt: string; personBps: number; released: boolean } | null;
  vesting: { id: number; beneficiary: Address; total: string; claimed: string; claimable: string; cliffEnds: string; ends: string } | null;
  airdrop: DistributionView | null;
  backer: DistributionView | null;
  seed: { usdc: string; tbloke: string } | null;
  /** CREATE2 address the token has (or will have). */
  predictedToken: Address | null;
}

export interface DistributionView {
  id: number;
  root: Hex;
  deadline: string;
  total: string;
  claimed: string;
}

export interface TokenClaim {
  ticker: string;
  token: Address;
  kind: "airdrop" | "backer" | "vesting";
  distributionId: number;
  /** Token amount (18 dp): the leaf amount, or what's claimable now for vesting. */
  amount: string;
  proof: Hex[];
  claimed: boolean;
  deadline: string | null;
}

export interface GraduationAttestation {
  attestation: {
    blokeId: number;
    traderCount: number;
    airdropRoot: Hex;
    airdropTotal: string;
    backerRoot: Hex;
    backerTotal: string;
    nonce: string;
    expiry: string;
  };
  signature: Hex;
  lists: { airdrop: { root: Hex; wallets: number }; backer: { root: Hex; wallets: number } };
}

/** A person's raise (A18): all-or-nothing tUSDC toward a goal; counts as backing at graduation. */
export interface RaiseView {
  id: number;
  blokeId: number;
  ticker: string;
  name: string;
  archetype: ArchetypeId | null;
  person: Address;
  goal: string;
  minCommit: string;
  raised: string;
  backers: number;
  openedAt: string;
  deadline: string;
  state: "open" | "succeeded" | "failed" | "cancelled" | "withdrawn";
  /** The requesting wallet's commitment (6 dp), when `?wallet=` was given. */
  committed: string | null;
}

/** Proof of work, simulated (A19). */
export interface PowItem {
  id: number;
  kind: "contract" | "repo" | "release" | "paper" | "product" | "post";
  title: string;
  url: string;
  /** Contract items: the deployment tx hash. */
  ref: string | null;
  status: "verified" | "self_reported" | "rejected";
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PowView {
  items: PowItem[];
  verified: number;
  total: number;
  /** WORK index points the items would add (simulation; not fed to the oracle). */
  simulatedWorkBoost: number;
}

export interface StatusView {
  chainId: number;
  staging: boolean;
  addresses: Record<string, Address>;
  oracle: { lastSeq: string; lastPushAgeMs: number | null; paused: boolean };
  blokes: { id: number; ticker: string; pushAgeMs: number | null; fresh: boolean }[];
  indexer: { block: string | null; lagBlocks: number | null };
  headBlock: string;
}

export interface Session {
  address: Address;
  identities: { provider: "github" | "x" | "test"; externalId: string; handle: string | null; qualifies: boolean }[];
}

export interface FaucetResult {
  txHash: Hex;
  amount: string;
  /** Gas drip sent alongside the first claim of an identity (amendment A8). */
  dripTxHash: Hex | null;
}

/** Signed attestation ready to submit from the wallet. */
export interface ClaimAttestation {
  blokeId: number;
  wallet: Address;
  nonce: string;
  expiry: string;
  signature: Hex;
}

export interface SourcesAttestation {
  blokeId: number;
  bitmap: number;
  linked: Address[];
  nonce: string;
  expiry: string;
  signature: Hex;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
