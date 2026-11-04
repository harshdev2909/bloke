// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Airdrop and backer claims (PRD §10.3): one contract, one distribution per (graduation,
/// kind). Leaves are OpenZeppelin StandardMerkleTree-style: keccak256(bytes.concat(keccak256(
/// abi.encode(account, amount)))), sorted-pair hashing. Claims close after 90 days and anyone can
/// then sweep the remainder to the treasury.
contract MerkleDistributor is AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Distribution {
        IERC20 token;
        bytes32 root;
        uint64 deadline;
        bool swept;
        address sweepTo;
        uint256 total;
        uint256 claimed;
    }

    Distribution[] public distributions;
    mapping(uint256 => mapping(address => bool)) public isClaimed;

    error AlreadyClaimed();
    error BadProof();
    error Closed();
    error StillOpen();
    error AlreadySwept();

    event DistributionCreated(uint256 indexed id, address indexed token, bytes32 root, uint256 total, uint64 deadline);
    event Claimed(uint256 indexed id, address indexed account, uint256 amount);
    event Swept(uint256 indexed id, uint256 amount);

    constructor(address authority) AccessManaged(authority) {}

    /// @notice LAUNCHER: records tokens already transferred to this contract.
    function create(IERC20 token, bytes32 root, uint256 total, uint64 deadline, address sweepTo) external restricted returns (uint256 id) {
        id = distributions.length;
        distributions.push(Distribution(token, root, deadline, false, sweepTo, total, 0));
        emit DistributionCreated(id, address(token), root, total, deadline);
    }

    function leaf(address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function claim(uint256 id, address account, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Distribution storage d = distributions[id];
        if (block.timestamp > d.deadline || d.swept) revert Closed();
        if (isClaimed[id][account]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, d.root, leaf(account, amount))) revert BadProof();
        isClaimed[id][account] = true;
        d.claimed += amount;
        d.token.safeTransfer(account, amount);
        emit Claimed(id, account, amount);
    }

    function sweep(uint256 id) external nonReentrant {
        Distribution storage d = distributions[id];
        if (block.timestamp <= d.deadline) revert StillOpen();
        if (d.swept) revert AlreadySwept();
        d.swept = true;
        uint256 rest = d.total - d.claimed;
        if (rest > 0) d.token.safeTransfer(d.sweepTo, rest);
        emit Swept(id, rest);
    }

    function distributionCount() external view returns (uint256) {
        return distributions.length;
    }
}
