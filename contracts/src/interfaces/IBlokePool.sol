// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What the MarketEngine needs from the pool. P1 ships SimplePool; P2's BlokePool (waterfall,
/// Floor/Edge decks) implements the same interface and reads the engine's per-market accumulators
/// at each crank (amendment A9: no pool write per fill).
interface IBlokePool {
    /// @notice First-loss capital behind the caps, E + R, in tUSDC (6 decimals).
    function capBase() external view returns (uint256);

    /// @notice ENGINE only. Sends up to `amount` tUSDC to the engine to fund a winning payout and
    /// returns what was actually sent (less only beyond a credit event).
    function cover(uint256 amount) external returns (uint256 sent);

    /// @notice True while the Bloke's Skin is at least MIN_SKIN (creator fee tier, PRD §9.4).
    function hasSkin(uint32 blokeId) external view returns (bool);
}
