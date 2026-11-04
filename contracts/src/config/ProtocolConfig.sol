// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {Keys} from "./Keys.sol";

/// @notice Contracts that keep a local, packed copy of the parameters they read on hot paths.
interface IConfigConsumer {
    function syncParams() external;
}

/// @title ProtocolConfig
/// @notice Every tunable parameter, each with hard min/max bounds fixed at deployment (PRD §12.1).
/// `set` is ADMIN-only through the AccessManager and can never leave the bounds.
contract ProtocolConfig is AccessManaged {
    struct Param {
        uint128 value;
        uint64 min; // bounds fit in 64 bits for every key; amounts use 6 decimals
        uint64 max;
        bool exists;
    }

    /// @notice True only for the staging contract set (PRD §20.2): loosens the shadow-period and
    /// history bounds so integration tests can trade minutes after listing. Immutable and public, so
    /// anyone can check the event deployment was made with `false`.
    bool public immutable staging;

    mapping(bytes32 => Param) private _params;
    mapping(bytes32 => address) private _addresses;

    /// @notice Contracts re-synced on every change, so their cached copies are never stale. Reading
    /// a cached slot instead of an external call per parameter saves a cold account access plus a
    /// cold slot per key on Monad, where both are priced well above Ethereum.
    address[] public consumers;

    event ParamChanged(bytes32 indexed key, uint256 oldValue, uint256 newValue);
    event AddressChanged(bytes32 indexed key, address oldValue, address newValue);
    event ConsumerAdded(address consumer);

    error OutOfBounds(bytes32 key, uint256 value);
    error UnknownKey(bytes32 key);
    error ZeroAddress();

    constructor(address authority, bool staging_) AccessManaged(authority) {
        staging = staging_;
        // Oracle
        _init(Keys.ORACLE_STEP_BPS, 300, 50, 1_000);
        _init(Keys.ORACLE_BAND_LO_BPS, 6_000, 3_000, 10_000);
        _init(Keys.ORACLE_BAND_HI_BPS, 14_000, 10_000, 20_000);
        _init(Keys.ORACLE_FRESH_SEC, 60, 10, 300);
        _init(Keys.ORACLE_MAX_ENTRIES, 32, 1, 64);
        _init(Keys.ORACLE_PAST_MS, 30_000, 5_000, 120_000);
        _init(Keys.ORACLE_FUTURE_MS, 3_000, 1_000, 10_000);

        // Markets
        _init(Keys.PREMIUM_CLAMP_BPS, 500, 50, 1_000);
        _init(Keys.PREMIUM_HALF_LIFE_SEC, 600, 60, 3_600);
        _init(Keys.DEPTH_T1_USDC, 300_000e6, 1_000e6, 10_000_000e6);
        _init(Keys.DEPTH_T2_USDC, 150_000e6, 1_000e6, 10_000_000e6);
        _init(Keys.DEPTH_T3_USDC, 75_000e6, 1_000e6, 10_000_000e6);
        _init(Keys.FUNDING_KAPPA_BPS_PER_HOUR, 200, 0, 2_500);
        _init(Keys.CLOSE_FEE_BPS, 300, 0, 1_000);
        _init(Keys.CREATOR_SHARE_BPS, 1_500, 0, 5_000);
        _init(Keys.CREATOR_SHARE_SKIN_BPS, 2_500, 0, 5_000);
        _init(Keys.MAX_PROFIT_BPS, 20_000, 5_000, 100_000);
        _init(Keys.FREEZE_MAX_SEC, 72 hours, 1 hours, 168 hours);

        // Caps (bps of Edge NAV + Reserve)
        _init(Keys.NET_CAP_MARKET_BPS, 300, 100, 2_000);
        _init(Keys.NET_CAP_GLOBAL_BPS, 3_000, 1_000, 10_000);
        _init(Keys.NET_CAP_HYPE_FAMILY_BPS, 1_500, 500, 5_000);
        _init(Keys.WALLET_CAP_USDC, 5_000e6, 100e6, 100_000e6);
        _init(Keys.MIN_LOT_USDC, 10e6, 1e6, 1_000e6);
        _init(Keys.MAX_LOTS_PER_MARKET, 20, 1, 100);
        _init(Keys.MAX_PENDING, 5, 1, 50);

        // Orders
        _init(Keys.CANCEL_AFTER_SEC, 30, 5, 600);
        _init(Keys.DEFAULT_DEADLINE_SEC, 120, 30, 600);
        _init(Keys.MAX_DEADLINE_SEC, 600, 60, 3_600);

        // Pool
        _init(Keys.EPOCH_SEC, 1 hours, 15 minutes, 24 hours);
        _init(Keys.PROTOCOL_FEE_BPS, 1_000, 0, 2_000);
        _init(Keys.RESERVE_TARGET_BPS, 200, 0, 1_000);
        _init(Keys.RESERVE_SHARE_BPS, 5_000, 0, 10_000);
        _init(Keys.SUBORDINATION_BPS, 2_000, 1_000, 5_000);
        _init(Keys.MIN_EDGE_USDC, 100_000e6, 1_000e6, 100_000_000e6);
        _init(Keys.FLOOR_RATE_CAP_BPS, 1_500, 0, 1_500);

        // Skin and claims
        _init(Keys.MIN_SKIN_USDC, 1_000e6, 1e6, 1_000_000e6);
        _init(Keys.CLAIM_WITHDRAW_DELAY_SEC, 24 hours, 1 hours, 7 days);
        _init(Keys.ROTATION_TIMELOCK_SEC, 72 hours, 1 hours, 14 days);
        if (staging_) {
            _init(Keys.SHADOW_SEC, 10 minutes, 1 minutes, 30 days);
            _init(Keys.MIN_HISTORY_HOURS, 0, 0, 168);
        } else {
            _init(Keys.SHADOW_SEC, 72 hours, 24 hours, 30 days);
            _init(Keys.MIN_HISTORY_HOURS, 24, 24, 168);
        }

        // Graduation (event build uses the demo profile in docs/prd/amendments.md §A2)
        _init(Keys.GRAD_MIN_HCS, 1_200_000, 1_000_000, 2_000_000);
        _init(Keys.GRAD_OI_DAYS, 7, 1, 30);
        _init(Keys.GRAD_MIN_OI_USDC, 20_000e6, 0, 100_000_000e6);
        if (staging_) {
            // A17: staging can graduate a Bloke within a day so the P4 path is testable after a deploy.
            _init(Keys.GRAD_AVG_DAYS, 14, 1, 30);
            _init(Keys.GRAD_MIN_TRADERS, 100, 0, 100_000);
            _init(Keys.GRAD_SKIN_DAYS, 14, 0, 30);
        } else {
            _init(Keys.GRAD_AVG_DAYS, 14, 3, 30);
            _init(Keys.GRAD_MIN_TRADERS, 100, 10, 100_000);
            _init(Keys.GRAD_SKIN_DAYS, 14, 1, 30);
        }
        _init(Keys.GRAD_FEE_USDC, 2_000e6, 0, 1_000_000e6);

        // Testnet
        _init(Keys.FAUCET_AMOUNT_USDC, 10_000e6, 1e6, 1_000_000e6);
        _init(Keys.FAUCET_COOLDOWN_SEC, 24 hours, 1 hours, 7 days);
    }

    function get(bytes32 key) external view returns (uint256) {
        Param storage p = _params[key];
        if (!p.exists) revert UnknownKey(key);
        return p.value;
    }

    function bounds(bytes32 key) external view returns (uint256 min, uint256 max) {
        Param storage p = _params[key];
        if (!p.exists) revert UnknownKey(key);
        return (p.min, p.max);
    }

    function getAddress(bytes32 key) external view returns (address) {
        return _addresses[key];
    }

    function set(bytes32 key, uint256 value) external restricted {
        Param storage p = _params[key];
        if (!p.exists) revert UnknownKey(key);
        if (value < p.min || value > p.max) revert OutOfBounds(key, value);
        emit ParamChanged(key, p.value, value);
        p.value = uint128(value);
        _notify();
    }

    /// @notice Rotates a signer or sets a sink address. The old value stops being accepted immediately.
    function setAddress(bytes32 key, address value) external restricted {
        if (value == address(0)) revert ZeroAddress();
        emit AddressChanged(key, _addresses[key], value);
        _addresses[key] = value;
        _notify();
    }

    /// @notice ADMIN: registers a consumer and syncs it immediately.
    function addConsumer(address consumer) external restricted {
        if (consumer == address(0)) revert ZeroAddress();
        consumers.push(consumer);
        IConfigConsumer(consumer).syncParams();
        emit ConsumerAdded(consumer);
    }

    function consumerCount() external view returns (uint256) {
        return consumers.length;
    }

    function _notify() private {
        for (uint256 i; i < consumers.length; ++i) {
            IConfigConsumer(consumers[i]).syncParams();
        }
    }

    function _init(bytes32 key, uint256 value, uint256 min, uint256 max) private {
        _params[key] = Param(uint128(value), uint64(min), uint64(max), true);
        emit ParamChanged(key, 0, value);
    }
}
