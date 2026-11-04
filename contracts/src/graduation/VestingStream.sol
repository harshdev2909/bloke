// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The person's 15% (PRD §10.3): nothing for a 90-day cliff, then linear over 365 days.
/// One contract holds every graduation's stream.
contract VestingStream is AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Stream {
        IERC20 token;
        address beneficiary;
        uint64 start;
        uint64 cliff;
        uint64 duration;
        uint256 total;
        uint256 claimed;
    }

    Stream[] public streams;

    error OnlyBeneficiary();
    error NothingToClaim();

    event StreamCreated(uint256 indexed id, address indexed token, address indexed beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration);
    event StreamClaimed(uint256 indexed id, uint256 amount);

    constructor(address authority) AccessManaged(authority) {}

    /// @notice LAUNCHER: records tokens already transferred to this contract.
    function create(IERC20 token, address beneficiary, uint256 total, uint64 start, uint64 cliff, uint64 duration)
        external
        restricted
        returns (uint256 id)
    {
        id = streams.length;
        streams.push(Stream(token, beneficiary, start, cliff, duration, total, 0));
        emit StreamCreated(id, address(token), beneficiary, total, start, cliff, duration);
    }

    /// @notice Vested so far: 0 before start + cliff, then linear to `total` over `duration`.
    function vested(uint256 id) public view returns (uint256) {
        Stream storage s = streams[id];
        uint256 from = uint256(s.start) + s.cliff;
        if (block.timestamp <= from) return 0;
        uint256 elapsed = block.timestamp - from;
        return elapsed >= s.duration ? s.total : (s.total * elapsed) / s.duration;
    }

    function claimable(uint256 id) public view returns (uint256) {
        return vested(id) - streams[id].claimed;
    }

    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Stream storage s = streams[id];
        if (msg.sender != s.beneficiary) revert OnlyBeneficiary();
        amount = claimable(id);
        if (amount == 0) revert NothingToClaim();
        s.claimed += amount;
        s.token.safeTransfer(s.beneficiary, amount);
        emit StreamClaimed(id, amount);
    }

    function streamCount() external view returns (uint256) {
        return streams.length;
    }
}
