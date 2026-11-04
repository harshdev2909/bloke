// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHumanIndexOracle} from "../interfaces/IHumanIndexOracle.sol";
import {MarketEngine} from "./MarketEngine.sol";

/// @title Settler
/// @notice Pushes a signed index and settles orders against it in one transaction (PRD §12.6), so a
/// request in block N normally fills in N+1. Stateless and permissionless.
contract Settler {
    IHumanIndexOracle public immutable oracle;
    MarketEngine public immutable engine;

    constructor(IHumanIndexOracle oracle_, MarketEngine engine_) {
        oracle = oracle_;
        engine = engine_;
    }

    function pushAndSettle(
        IHumanIndexOracle.IndexPush calldata p,
        bytes calldata sig,
        uint64[] calldata orderIds,
        uint64[] calldata exhaustIds
    ) external {
        oracle.push(p, sig);
        if (exhaustIds.length != 0) engine.exhaust(exhaustIds); // exhaust first so U stays exact
        if (orderIds.length != 0) engine.settle(orderIds);
    }
}
