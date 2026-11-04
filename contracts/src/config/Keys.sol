// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Parameter keys for ProtocolConfig (PRD §18, as amended in docs/prd/amendments.md).
/// Units: *_BPS in basis points, *_SEC in seconds, *_MS in milliseconds, *_USDC in tUSDC (6 decimals),
/// INDEX values scaled 1e4 (100.0 = 1_000_000).
library Keys {
    // Oracle
    bytes32 internal constant ORACLE_STEP_BPS = "ORACLE_STEP_BPS";
    bytes32 internal constant ORACLE_BAND_LO_BPS = "ORACLE_BAND_LO_BPS";
    bytes32 internal constant ORACLE_BAND_HI_BPS = "ORACLE_BAND_HI_BPS";
    bytes32 internal constant ORACLE_FRESH_SEC = "ORACLE_FRESH_SEC";
    bytes32 internal constant ORACLE_MAX_ENTRIES = "ORACLE_MAX_ENTRIES";
    bytes32 internal constant ORACLE_PAST_MS = "ORACLE_PAST_MS";
    bytes32 internal constant ORACLE_FUTURE_MS = "ORACLE_FUTURE_MS";

    // Markets
    bytes32 internal constant PREMIUM_CLAMP_BPS = "PREMIUM_CLAMP_BPS";
    bytes32 internal constant PREMIUM_HALF_LIFE_SEC = "PREMIUM_HALF_LIFE_SEC";
    bytes32 internal constant DEPTH_T1_USDC = "DEPTH_T1_USDC";
    bytes32 internal constant DEPTH_T2_USDC = "DEPTH_T2_USDC";
    bytes32 internal constant DEPTH_T3_USDC = "DEPTH_T3_USDC";
    bytes32 internal constant FUNDING_KAPPA_BPS_PER_HOUR = "FUNDING_KAPPA_BPS_PER_HOUR";
    bytes32 internal constant CLOSE_FEE_BPS = "CLOSE_FEE_BPS";
    bytes32 internal constant CREATOR_SHARE_BPS = "CREATOR_SHARE_BPS";
    bytes32 internal constant CREATOR_SHARE_SKIN_BPS = "CREATOR_SHARE_SKIN_BPS";
    bytes32 internal constant MAX_PROFIT_BPS = "MAX_PROFIT_BPS";
    bytes32 internal constant FREEZE_MAX_SEC = "FREEZE_MAX_SEC";

    // Caps
    bytes32 internal constant NET_CAP_MARKET_BPS = "NET_CAP_MARKET_BPS";
    bytes32 internal constant NET_CAP_GLOBAL_BPS = "NET_CAP_GLOBAL_BPS";
    bytes32 internal constant NET_CAP_HYPE_FAMILY_BPS = "NET_CAP_HYPE_FAMILY_BPS";
    bytes32 internal constant WALLET_CAP_USDC = "WALLET_CAP_USDC";
    bytes32 internal constant MIN_LOT_USDC = "MIN_LOT_USDC";
    bytes32 internal constant MAX_LOTS_PER_MARKET = "MAX_LOTS_PER_MARKET";
    bytes32 internal constant MAX_PENDING = "MAX_PENDING";

    // Orders
    bytes32 internal constant CANCEL_AFTER_SEC = "CANCEL_AFTER_SEC";
    bytes32 internal constant DEFAULT_DEADLINE_SEC = "DEFAULT_DEADLINE_SEC";
    bytes32 internal constant MAX_DEADLINE_SEC = "MAX_DEADLINE_SEC";

    // Pool
    bytes32 internal constant EPOCH_SEC = "EPOCH_SEC";
    bytes32 internal constant PROTOCOL_FEE_BPS = "PROTOCOL_FEE_BPS";
    bytes32 internal constant RESERVE_TARGET_BPS = "RESERVE_TARGET_BPS";
    bytes32 internal constant RESERVE_SHARE_BPS = "RESERVE_SHARE_BPS";
    bytes32 internal constant SUBORDINATION_BPS = "SUBORDINATION_BPS";
    bytes32 internal constant MIN_EDGE_USDC = "MIN_EDGE_USDC";
    bytes32 internal constant FLOOR_RATE_CAP_BPS = "FLOOR_RATE_CAP_BPS";

    // Skin and claims
    bytes32 internal constant MIN_SKIN_USDC = "MIN_SKIN_USDC";
    bytes32 internal constant CLAIM_WITHDRAW_DELAY_SEC = "CLAIM_WITHDRAW_DELAY_SEC";
    bytes32 internal constant ROTATION_TIMELOCK_SEC = "ROTATION_TIMELOCK_SEC";
    bytes32 internal constant SHADOW_SEC = "SHADOW_SEC";
    bytes32 internal constant MIN_HISTORY_HOURS = "MIN_HISTORY_HOURS";

    // Graduation
    bytes32 internal constant GRAD_MIN_HCS = "GRAD_MIN_HCS";
    bytes32 internal constant GRAD_AVG_DAYS = "GRAD_AVG_DAYS";
    bytes32 internal constant GRAD_OI_DAYS = "GRAD_OI_DAYS";
    bytes32 internal constant GRAD_MIN_OI_USDC = "GRAD_MIN_OI_USDC";
    bytes32 internal constant GRAD_MIN_TRADERS = "GRAD_MIN_TRADERS";
    bytes32 internal constant GRAD_SKIN_DAYS = "GRAD_SKIN_DAYS";
    bytes32 internal constant GRAD_FEE_USDC = "GRAD_FEE_USDC";

    // Testnet
    bytes32 internal constant FAUCET_AMOUNT_USDC = "FAUCET_AMOUNT_USDC";
    bytes32 internal constant FAUCET_COOLDOWN_SEC = "FAUCET_COOLDOWN_SEC";

    // Addresses
    bytes32 internal constant ORACLE_SIGNER = "ORACLE_SIGNER";
    bytes32 internal constant ATTESTER = "ATTESTER";
    bytes32 internal constant TREASURY = "TREASURY";
}
