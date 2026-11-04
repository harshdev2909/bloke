// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds graduation LP tokens for 365 days (PRD §10.3). At unlock anyone can release a lock:
/// the LP splits pro rata to what each side seeded (the person's creator fees vs the protocol's
/// graduation fee). LP fees compound inside the position until then.
contract LPLocker is AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Lock {
        IERC20 lp;
        uint64 unlockAt;
        uint16 personBps;
        bool released;
        uint256 amount;
        address person;
        address treasury;
    }

    Lock[] public locks;

    error Locked();
    error Released();
    error BadShare();

    event LockCreated(uint256 indexed id, address indexed lp, uint256 amount, uint64 unlockAt, address person, uint16 personBps);
    event LockReleased(uint256 indexed id, uint256 toPerson, uint256 toTreasury);

    constructor(address authority) AccessManaged(authority) {}

    /// @notice LAUNCHER: records LP already transferred to this contract.
    function lock(IERC20 lp, uint256 amount, uint64 unlockAt, address person, uint16 personBps, address treasury)
        external
        restricted
        returns (uint256 id)
    {
        if (personBps > 10_000) revert BadShare();
        id = locks.length;
        locks.push(Lock(lp, unlockAt, personBps, false, amount, person, treasury));
        emit LockCreated(id, address(lp), amount, unlockAt, person, personBps);
    }

    function release(uint256 id) external nonReentrant {
        Lock storage l = locks[id];
        if (l.released) revert Released();
        if (block.timestamp < l.unlockAt) revert Locked();
        l.released = true;
        uint256 toPerson = (l.amount * l.personBps) / 10_000;
        uint256 toTreasury = l.amount - toPerson;
        if (toPerson > 0) l.lp.safeTransfer(l.person, toPerson);
        if (toTreasury > 0) l.lp.safeTransfer(l.treasury, toTreasury);
        emit LockReleased(id, toPerson, toTreasury);
    }

    function lockCount() external view returns (uint256) {
        return locks.length;
    }
}
