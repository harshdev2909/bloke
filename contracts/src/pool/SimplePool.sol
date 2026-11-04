// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBlokePool} from "../interfaces/IBlokePool.sol";

/// @title SimplePool
/// @notice P1 counterparty: holds the seeded liquidity, funds winning payouts and receives losing
/// collateral and retained fees. Its whole balance stands in for E + R. Replaced in P2 by BlokePool
/// (Floor/Edge decks, Skin, hourly waterfall) behind the same IBlokePool interface.
contract SimplePool is IBlokePool, AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public engine;

    event EngineSet(address engine);
    event Covered(uint256 requested, uint256 sent);

    error NotEngine();
    error EngineAlreadySet();

    constructor(address authority, IERC20 usdc_) AccessManaged(authority) {
        usdc = usdc_;
    }

    function setEngine(address engine_) external restricted {
        if (engine != address(0)) revert EngineAlreadySet();
        engine = engine_;
        emit EngineSet(engine_);
    }

    function capBase() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function hasSkin(uint32) external pure returns (bool) {
        return false;
    }

    function cover(uint256 amount) external nonReentrant returns (uint256 sent) {
        if (msg.sender != engine) revert NotEngine();
        uint256 bal = usdc.balanceOf(address(this));
        sent = amount > bal ? bal : amount;
        if (sent > 0) usdc.safeTransfer(engine, sent);
        emit Covered(amount, sent);
    }
}
