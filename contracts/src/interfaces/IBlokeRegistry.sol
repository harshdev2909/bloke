// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IBlokeRegistry {
    enum Status {
        None,
        Shadow,
        Live,
        DelistPending, // markets ReduceOnly; settlement TWAP already snapshotted
        Delisted, // markets SettleOnly
        Graduated
    }

    struct BlokeInit {
        bytes16 ticker;
        string name;
        bytes32 sourceIdsHash;
        uint8 tier; // 1..3
        uint8 workSourceMask; // which WORK sources the listing has (bit0 commits, bit1 releases, bit2 on-chain)
    }

    function status(uint32 blokeId) external view returns (Status);
    function claimedWallet(uint32 blokeId) external view returns (address);
    function isLinked(uint32 blokeId, address wallet) external view returns (bool);
    function tier(uint32 blokeId) external view returns (uint8);
    function settlePrice(uint32 blokeId) external view returns (uint32 b, uint32 h, uint32 w);
    function creditCreator(uint32 blokeId, uint256 amount) external;
}

/// @notice Hooks the registry calls on the market engine once it is wired (P1).
interface IRegistryHooks {
    function onListed(uint32 blokeId, uint8 tier) external;
    function onBlokeStatus(uint32 blokeId, IBlokeRegistry.Status status) external;
}
