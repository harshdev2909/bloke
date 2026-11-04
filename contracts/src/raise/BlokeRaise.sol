// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBlokeRegistry} from "../interfaces/IBlokeRegistry.sol";
import {BlokeRegistry} from "../registry/BlokeRegistry.sol";

/// @notice Raises (amendment A18): a claimed person asks backers for tUSDC toward a goal. All or
/// nothing: the person withdraws once the goal is met; if the deadline passes first, or the person
/// cancels, every backer takes their commitment back. Commitments carry no cash-flow rights. They
/// count as backing in the graduation backer allocation (PRD §10.3), weighted off-chain.
contract BlokeRaise is AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Open,
        Succeeded,
        Failed, // deadline passed below goal
        Cancelled,
        Withdrawn
    }

    struct Raise {
        uint32 blokeId;
        State state;
        uint64 openedAt;
        uint64 deadline;
        address person;
        uint96 goal;
        uint96 raised;
        uint96 minCommit;
        uint32 backers;
    }

    uint256 public constant MIN_GOAL = 1_000e6;
    uint256 public constant MAX_GOAL = 1_000_000e6;
    uint256 public constant MAX_DURATION = 30 days;
    uint256 public constant MIN_DURATION = 1 hours;

    IERC20 public immutable usdc;
    BlokeRegistry public immutable registry;

    Raise[] internal _raises;
    mapping(uint256 => mapping(address => uint96)) public committed;
    /// @notice Latest raise per Bloke, +1 (0 = never raised).
    mapping(uint32 => uint256) public latestOf;

    error NotClaimedWallet();
    error BadStatus();
    error AlreadyRaising();
    error BadGoal();
    error BadDuration();
    error NotOpen();
    error BelowMinimum();
    error SelfCommit();
    error NothingToRefund();
    error NotRefundable();
    error NotSucceeded();

    event RaiseOpened(uint256 indexed id, uint32 indexed blokeId, address person, uint256 goal, uint64 deadline, uint256 minCommit);
    event Committed(uint256 indexed id, address indexed backer, uint256 amount, uint256 raised);
    event RaiseSucceeded(uint256 indexed id, uint256 raised);
    event RaiseCancelled(uint256 indexed id);
    event Withdrawn(uint256 indexed id, address person, uint256 amount);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);

    constructor(address authority, IERC20 usdc_, BlokeRegistry registry_) AccessManaged(authority) {
        usdc = usdc_;
        registry = registry_;
    }

    // ---------------------------------------------------------------- person

    function open(uint32 blokeId, uint256 goal, uint256 duration, uint256 minCommit) external returns (uint256 id) {
        BlokeRegistry.Bloke memory bk = registry.bloke(blokeId);
        if (msg.sender != bk.wallet || bk.wallet == address(0)) revert NotClaimedWallet();
        if (bk.claimFrozen || bk.abuseFlag != 0 || (bk.status != IBlokeRegistry.Status.Live && bk.status != IBlokeRegistry.Status.Shadow)) {
            revert BadStatus();
        }
        uint256 last = latestOf[blokeId];
        if (last != 0 && stateOf(last - 1) == State.Open) revert AlreadyRaising();
        if (goal < MIN_GOAL || goal > MAX_GOAL) revert BadGoal();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (minCommit == 0 || minCommit > goal) revert BelowMinimum();
        id = _raises.length;
        uint64 deadline = uint64(block.timestamp + duration);
        _raises.push(Raise(blokeId, State.Open, uint64(block.timestamp), deadline, msg.sender, uint96(goal), 0, uint96(minCommit), 0));
        latestOf[blokeId] = id + 1;
        emit RaiseOpened(id, blokeId, msg.sender, goal, deadline, minCommit);
    }

    function cancel(uint256 id) external {
        Raise storage r = _raises[id];
        if (msg.sender != r.person) revert NotClaimedWallet();
        if (stateOf(id) != State.Open) revert NotOpen();
        r.state = State.Cancelled;
        emit RaiseCancelled(id);
    }

    function withdraw(uint256 id) external nonReentrant {
        Raise storage r = _raises[id];
        if (msg.sender != r.person) revert NotClaimedWallet();
        if (r.state != State.Succeeded) revert NotSucceeded();
        r.state = State.Withdrawn;
        usdc.safeTransfer(r.person, r.raised);
        emit Withdrawn(id, r.person, r.raised);
    }

    // ---------------------------------------------------------------- backers

    /// @notice Commits up to `amount`; anything beyond the goal stays with the backer (hard cap).
    function commit(uint256 id, uint256 amount) external nonReentrant returns (uint256 taken) {
        Raise storage r = _raises[id];
        if (stateOf(id) != State.Open) revert NotOpen();
        if (msg.sender == r.person || registry.isLinked(r.blokeId, msg.sender)) revert SelfCommit();
        uint256 room = uint256(r.goal) - r.raised;
        taken = amount > room ? room : amount;
        // The last commitment may be smaller than the minimum if that's all the room left.
        if (taken < r.minCommit && taken != room) revert BelowMinimum();
        if (committed[id][msg.sender] == 0) r.backers += 1;
        committed[id][msg.sender] += uint96(taken);
        r.raised += uint96(taken);
        usdc.safeTransferFrom(msg.sender, address(this), taken);
        emit Committed(id, msg.sender, taken, r.raised);
        if (r.raised == r.goal) {
            r.state = State.Succeeded;
            emit RaiseSucceeded(id, r.raised);
        }
    }

    function refund(uint256 id) external nonReentrant returns (uint256 amount) {
        State s = stateOf(id);
        if (s != State.Failed && s != State.Cancelled) revert NotRefundable();
        amount = committed[id][msg.sender];
        if (amount == 0) revert NothingToRefund();
        committed[id][msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    /// @notice The stored state, with Open reported as Failed once the deadline has passed.
    function stateOf(uint256 id) public view returns (State) {
        Raise storage r = _raises[id];
        if (r.state == State.Open && block.timestamp > r.deadline) return State.Failed;
        return r.state;
    }

    function raiseInfo(uint256 id) external view returns (Raise memory r) {
        r = _raises[id];
        r.state = stateOf(id);
    }

    function raiseCount() external view returns (uint256) {
        return _raises.length;
    }
}
