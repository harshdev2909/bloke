/**
 * Plain-language messages for contract custom errors and engine reject reasons (PRD §14.5). The
 * frontend decodes reverts with viem against the ABIs, then looks the name up here.
 */
export const ERROR_MESSAGES: Record<string, string> = {
  OppositeSideOpen: "Close your short on this market before going long (or the reverse).",
  WalletCapExceeded: "This market allows up to 5,000 tUSDC per wallet.",
  BelowMinLot: "The minimum size is 10 tUSDC.",
  TooManyPending: "You have 5 orders waiting to fill. Wait for one to finish.",
  TooManyLots: "You have the maximum number of open positions on this market.",
  CancelTooEarly: "You can cancel 30 seconds after placing the order.",
  FaucetCooldown: "This account already claimed in the last 24 hours.",
  ClaimIsFrozen: "This profile is under review. Withdrawals are paused.",
  MarketNotTradable: "This market isn't open for trading right now.",
  SelfTrade: "You can't trade markets on your own profile.",
  DeadlineTooFar: "Order deadlines can be at most 10 minutes out.",
  SlippageTooHigh: "Slippage can be at most 10%.",
  ClosePending: "A close is already pending for this position.",
  NothingToClaim: "Nothing to claim yet.",
  AlreadyClaimed: "This profile has already been claimed.",
  BadAttestation: "The signature expired or doesn't match. Request a new one.",
  Expired: "The signature expired. Request a new one.",
  // Graduation (P4)
  NotClaimedWallet: "Only the wallet that claimed this profile can graduate it.",
  CheckFailed: "A graduation check stopped passing. Refresh the checklist and try again.",
  AttestationExpired: "The graduation signature expired. Request a new one.",
  NonceUsed: "That signature was already used. Request a new one.",
  BadTotals: "The allocation lists don't add up. Request a new signature.",
  PairNotClean: "The pool for this token was tampered with. The team has been alerted.",
  NothingToSeed: "There's nothing to seed the pool with yet.",
  BadProof: "This claim doesn't match the published list.",
  Closed: "The claim window has closed.",
  OnlyBeneficiary: "Only the person can claim their vesting.",
  TransfersDisabled: "This token unlocks when graduation completes.",
  InsufficientOutputAmount: "The pool price moved. Try again with a smaller amount.",
  K: "The pool price moved. Try again.",
  // Raises (A18)
  AlreadyRaising: "A raise is already open for this profile.",
  BadGoal: "Goals run from 1,000 to 1,000,000 tUSDC.",
  BadDuration: "A raise runs from 1 hour to 30 days.",
  NotOpen: "This raise isn't open.",
  BelowMinimum: "That's below this raise's minimum.",
  SelfCommit: "You can't back your own raise.",
  NotRefundable: "Refunds open if the raise ends below its goal or is cancelled.",
  NothingToRefund: "Nothing to refund.",
  NotSucceeded: "The raise hasn't reached its goal.",
};

export const REJECT_MESSAGES: Record<string, string> = {
  Slippage: "The price moved more than your slippage limit. Your tUSDC is back.",
  NetCap: "Too many traders are on this side. Your tUSDC is back.",
  GlobalCap: "The pool is at its total exposure limit. Your tUSDC is back.",
  FamilyCap: "Too much exposure to HYPE across all profiles. Your tUSDC is back.",
  Status: "This market only accepts orders that reduce exposure right now. Your tUSDC is back.",
  Lagging: "The index is catching up to a big move; this side is paused. Your tUSDC is back.",
  Group: "The other leg of the spread couldn't fill, so both were refunded.",
  LotNotOpen: "This position was already closed.",
  Stale: "Waiting for a fresh index.",
};

export function messageFor(name: string): string {
  return ERROR_MESSAGES[name] ?? REJECT_MESSAGES[name] ?? name;
}
