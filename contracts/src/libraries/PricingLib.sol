// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SD59x18, sd, exp2} from "@prb/math/SD59x18.sol";

/// @title PricingLib
/// @notice Premium decay, fill price and the closed-form funding integral (PRD §6.1–6.2).
/// All values are 18-decimal fixed point (WAD). Premiums are signed WAD fractions (0.05e18 = 5%).
library PricingLib {
    int256 internal constant WAD = 1e18;
    int256 internal constant LN2 = 693_147_180_559_945_309; // ln 2 in WAD

    /// @notice 2^(-dt/h) in WAD.
    function decayFactor(uint256 dt, uint256 halfLife) internal pure returns (int256) {
        if (dt == 0) return WAD;
        // exp2 underflows to 0 below about -59.79; anything past 60 half-lives is zero anyway.
        if (dt >= halfLife * 60) return 0;
        return exp2(sd(-int256((dt * 1e18) / halfLife))).unwrap();
    }

    /// @notice π(t) = π0 · 2^(-dt/h).
    function decayed(int256 premium0, uint256 dt, uint256 halfLife) internal pure returns (int256) {
        return (premium0 * decayFactor(dt, halfLife)) / WAD;
    }

    /// @notice Funding accrued per unit over dt with the premium decaying from π0 and the index held
    /// at `index` (WAD price): κ · I · π0 · h / (3600 ln2) · (1 − 2^(-dt/h)).
    /// @param kappaBpsPerHour κ in bps per hour (200 = 0.02/h).
    function fundingDelta(int256 index, int256 premium0, uint256 dt, uint256 halfLife, uint256 kappaBpsPerHour)
        internal
        pure
        returns (int256)
    {
        if (dt == 0 || premium0 == 0 || kappaBpsPerHour == 0) return 0;
        int256 oneMinus = WAD - decayFactor(dt, halfLife);
        // index · π0 / WAD  → WAD price; × κ (bps → /1e4); × h; × (1 − f)/WAD; / (3600 · ln2/WAD)
        int256 x = (index * premium0) / WAD;
        x = (x * int256(kappaBpsPerHour)) / 10_000;
        x = (x * int256(halfLife) * oneMinus) / WAD;
        return (x * WAD) / (3600 * LN2);
    }

    /// @notice Premium after a trade of notional N against depth D, clamped to ±clamp.
    /// @param dir +1 buys (long open, short close), −1 sells.
    function premiumAfter(int256 premium, int8 dir, uint256 notionalWad, uint256 depthWad, int256 clamp)
        internal
        pure
        returns (int256 p)
    {
        // Impact rounds up in magnitude: buys pay a little more and sells receive a little less.
        int256 impact = int256((notionalWad * 1e18 + depthWad - 1) / depthWad);
        p = dir > 0 ? premium + impact : premium - impact;
        if (p > clamp) p = clamp;
        if (p < -clamp) p = -clamp;
    }

    /// @notice I · (1 + (π + π')/2). Buys round up and sells round down, so rounding favours the pool.
    function fillPrice(int256 index, int256 premiumBefore, int256 premiumAfter_, int8 dir)
        internal
        pure
        returns (uint256)
    {
        int256 num = index * (2 * WAD + premiumBefore + premiumAfter_);
        int256 den = 2 * WAD;
        int256 q = num / den;
        if (dir > 0 && num % den != 0) q += 1;
        return uint256(q);
    }

    /// @notice I · (1 + π).
    function mark(int256 index, int256 premium) internal pure returns (uint256) {
        return uint256((index * (WAD + premium)) / WAD);
    }

    /// @notice Oracle index (1e4-scaled, 100.0 = 1_000_000) → WAD price (100.0 → 100e18).
    function indexToWad(uint32 index) internal pure returns (int256) {
        return int256(uint256(index)) * 1e14;
    }
}
