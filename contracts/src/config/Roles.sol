// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice AccessManager role ids (PRD §16.3). ADMIN is the manager's built-in role 0.
library Roles {
    uint64 internal constant ADMIN = 0;
    uint64 internal constant GUARDIAN = 1;
    uint64 internal constant LISTER = 2;
    uint64 internal constant REP_PUBLISHER = 3;
    // Contract-to-contract roles
    uint64 internal constant REGISTRY = 10;
    uint64 internal constant ENGINE = 11;
    uint64 internal constant POOL = 12;
    uint64 internal constant LAUNCHER = 13;
}
