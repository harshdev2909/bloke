// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHumanIndexOracle} from "../interfaces/IHumanIndexOracle.sol";
import {IBlokeRegistry, IRegistryHooks} from "../interfaces/IBlokeRegistry.sol";
import {IBlokePool} from "../interfaces/IBlokePool.sol";
import {IProtocolConfig} from "../interfaces/IProtocolConfig.sol";
import {Keys} from "../config/Keys.sol";
import {PricingLib} from "../libraries/PricingLib.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title MarketEngine
/// @notice All 3 × N perpetual markets (PRD §6–7, amendments A1, A4, A5, A7, A9). Every open and
/// close is a two-step order filled at the first index pushed after the request. No leverage: notional
/// at entry equals collateral. Keeper functions are permissionless.
contract MarketEngine is IRegistryHooks, AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for int256;
    using SafeCast for uint256;

    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Shadow,
        Live,
        ReduceOnly,
        Frozen,
        SettleOnly,
        Settled
    }

    enum Kind {
        None,
        Open,
        Close
    }

    enum OrderStatus {
        None,
        Pending,
        Filled,
        Rejected,
        Cancelled,
        Expired
    }

    enum LotStatus {
        None,
        Open,
        Closed,
        Exhausted,
        ProfitCapped,
        Settled
    }

    /// @dev Reject reasons are outcomes, not reverts, so one bad order never blocks a batch.
    enum Reason {
        None,
        Slippage,
        NetCap,
        GlobalCap,
        FamilyCap,
        Status,
        Stale,
        Lagging,
        Group,
        LotNotOpen
    }

    /// @dev Packed into 7 slots (was 16): every fill and touch reads and writes these, and Monad
    /// prices cold storage well above Ethereum.
    struct Market {
        // slot 0
        Status status;
        uint8 tier;
        uint32 blokeId;
        uint8 leg; // IHumanIndexOracle.Leg
        uint64 ts; // last touch
        uint64 frozenAt;
        uint32 lastIndex; // 1e4-scaled index at last touch
        uint32 settleIndex; // fixed price for SettleOnly
        // slot 1
        uint32 orderCount;
        uint32 lotCount;
        uint32 openLots;
        int64 premium; // WAD fraction, |π| ≤ 0.1e18
        uint96 grossCollateral; // Σ collateral of open lots (6 dp)
        // slot 2
        int128 fundingIndex; // F, WAD price per unit
        int128 net; // Σ s·u (WAD units)
        // slot 3
        int128 sumSUP; // Σ s·u·Pentry / WAD
        int128 sumSUF; // Σ s·u·Fentry / WAD
        // slot 4
        uint128 netAbsCached; // |net|·I as last counted in globalNetAbs (WAD tUSDC)
        int128 familyCached; // this market's contribution to hypeFamily (WAD tUSDC)
        // slot 5
        uint128 oiTimeAcc; // Σ grossCollateral · seconds (graduation check 5)
        int128 realizedGrossAcc; // cumulative Σ gross of finished lots (WAD), read by the pool crank
        // slot 6
        uint128 feeRetainedAcc; // cumulative fees kept by the pool (6 dp)
        uint128 creatorFeeAcc; // cumulative creator fees (6 dp)
    }

    /// @dev Parameters cached from ProtocolConfig, re-synced on every config change (3 slots instead of
    /// an external call per parameter).
    struct Params {
        uint16 halfLife;
        uint16 kappaBpsPerHour;
        uint16 clampBps;
        uint16 closeFeeBps;
        uint16 creatorShareBps;
        uint16 creatorShareSkinBps;
        uint32 maxProfitBps;
        uint16 netCapMarketBps;
        uint16 netCapGlobalBps;
        uint16 netCapFamilyBps;
        uint8 maxLots;
        uint8 maxPending;
        uint16 cancelAfter;
        uint16 defaultDeadline;
        uint16 maxDeadline;
        uint32 freezeMax;
        uint32 minLot;
        uint64 walletCap;
        uint64 depthT1;
        uint64 depthT2;
        uint64 depthT3;
    }

    struct Order {
        address owner;
        uint32 marketId;
        int8 side;
        Kind kind;
        OrderStatus status;
        uint16 maxSlippageBps;
        uint96 collateral; // opens only
        uint64 seqAtRequest;
        uint64 requestedAt;
        uint64 deadline;
        uint64 lotId; // closes only
        uint64 partner; // spread leg partner order
        uint128 refMark; // WAD
    }

    /// @dev 4 slots (was 5): a new lot writes only fresh slots, the costliest kind of write.
    struct Lot {
        // slot 0
        address owner;
        uint32 marketId;
        int8 side;
        LotStatus status;
        bool closePending;
        uint32 entryIndex;
        // slot 1
        uint96 collateral;
        uint128 units; // WAD
        // slot 2
        uint128 entryPrice; // WAD
        int128 fundingEntry;
        // slot 3
        uint64 openedAt;
        uint64 groupId;
    }

    struct Exposure {
        int8 side;
        uint16 lots;
        uint16 pendingOpens;
        uint96 collateral; // open + pending, 6 dp
    }

    struct Fill {
        Reason reason;
        uint256 price;
        int256 premiumAfter;
        uint256 units;
    }

    // ---------------------------------------------------------------- constants and state

    int256 internal constant WAD = 1e18;
    uint256 internal constant USDC_TO_WAD = 1e12;
    uint256 public constant MAX_BATCH = 100;
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;
    uint256 public constant DELIST_TWAP_SEC = 60 minutes;
    int256 internal constant BLEND_HYPE_WEIGHT = 0.35e18;

    IProtocolConfig public immutable config;
    IHumanIndexOracle public immutable oracle;
    IBlokeRegistry public immutable registry;
    IBlokePool public immutable pool;
    IERC20 public immutable usdc;

    Params public params;
    bool public globalReduceOnly;
    uint256 public globalNetAbs; // Σ |net_m| · I_m (WAD tUSDC)
    int256 public hypeFamily; // Σ w_m · net_m · I_m over HYPE-weighted legs (A4)

    mapping(uint32 => Market) internal _markets;
    mapping(uint64 => Order) internal _orders;
    mapping(uint64 => Lot) internal _lots;
    mapping(uint64 => uint64[2]) public groupLots;
    mapping(address => mapping(uint32 => Exposure)) public exposure;
    mapping(address => uint256) public pendingCount;
    mapping(address => uint256) public claimable;
    mapping(address => uint256) public iou;

    // ---------------------------------------------------------------- events and errors

    event MarketCreated(uint32 indexed marketId, uint32 indexed blokeId, uint8 leg, uint8 tier);
    event MarketStatusChanged(uint32 indexed marketId, Status status, uint32 settleIndex);
    event OrderRequested(
        uint64 indexed orderId,
        address indexed owner,
        uint32 indexed marketId,
        int8 side,
        uint96 collateral,
        Kind kind,
        uint64 seqAtRequest,
        uint64 deadline,
        uint64 lotId
    );
    event SpreadLinked(uint64 indexed workOrder, uint64 indexed hypeOrder);
    event OrderFilled(uint64 indexed orderId, uint64 indexed lotId, uint256 fillPrice, uint32 index, int256 premiumAfter);
    event OrderRejected(uint64 indexed orderId, Reason reason);
    event OrderDeferred(uint64 indexed orderId, Reason reason);
    event OrderCancelled(uint64 indexed orderId);
    event OrderExpired(uint64 indexed orderId);
    event OrderSkipped(uint64 indexed orderId);
    event LotClosed(
        uint64 indexed lotId,
        LotStatus how,
        uint256 exitPrice,
        int256 pricePnl,
        int256 fundingPnl,
        uint256 fee,
        uint256 creatorFee,
        uint256 payout
    );
    event FundingAccrued(uint32 indexed marketId, int256 fundingIndex, int256 premium);
    event PayoutCredited(address indexed owner, uint256 amount);
    event IouRecorded(address indexed owner, uint256 amount);
    event Claimed(address indexed owner, uint256 amount);
    event GlobalReduceOnly(bool on);

    error MarketNotTradable();
    error OppositeSideOpen();
    error BelowMinLot();
    error WalletCapExceeded();
    error TooManyLots();
    error TooManyPending();
    error NotOwner();
    error CancelTooEarly();
    error AlreadyFinal();
    error DeadlineTooFar();
    error BadSide();
    error SlippageTooHigh();
    error SelfTrade();
    error BatchTooLarge();
    error NotRegistry();
    error BadStatusTransition();
    error FreezeNotExpired();
    error ClosePending();
    error NothingToClaim();

    constructor(
        address authority,
        IProtocolConfig config_,
        IHumanIndexOracle oracle_,
        IBlokeRegistry registry_,
        IBlokePool pool_,
        IERC20 usdc_
    ) AccessManaged(authority) {
        config = config_;
        oracle = oracle_;
        registry = registry_;
        pool = pool_;
        usdc = usdc_;
        syncParams();
    }

    /// @notice Copies parameters from ProtocolConfig. Permissionless and idempotent; ProtocolConfig
    /// calls it on every change.
    function syncParams() public {
        params = Params({
            halfLife: config.get(Keys.PREMIUM_HALF_LIFE_SEC).toUint16(),
            kappaBpsPerHour: config.get(Keys.FUNDING_KAPPA_BPS_PER_HOUR).toUint16(),
            clampBps: config.get(Keys.PREMIUM_CLAMP_BPS).toUint16(),
            closeFeeBps: config.get(Keys.CLOSE_FEE_BPS).toUint16(),
            creatorShareBps: config.get(Keys.CREATOR_SHARE_BPS).toUint16(),
            creatorShareSkinBps: config.get(Keys.CREATOR_SHARE_SKIN_BPS).toUint16(),
            maxProfitBps: config.get(Keys.MAX_PROFIT_BPS).toUint32(),
            netCapMarketBps: config.get(Keys.NET_CAP_MARKET_BPS).toUint16(),
            netCapGlobalBps: config.get(Keys.NET_CAP_GLOBAL_BPS).toUint16(),
            netCapFamilyBps: config.get(Keys.NET_CAP_HYPE_FAMILY_BPS).toUint16(),
            maxLots: config.get(Keys.MAX_LOTS_PER_MARKET).toUint8(),
            maxPending: config.get(Keys.MAX_PENDING).toUint8(),
            cancelAfter: config.get(Keys.CANCEL_AFTER_SEC).toUint16(),
            defaultDeadline: config.get(Keys.DEFAULT_DEADLINE_SEC).toUint16(),
            maxDeadline: config.get(Keys.MAX_DEADLINE_SEC).toUint16(),
            freezeMax: config.get(Keys.FREEZE_MAX_SEC).toUint32(),
            minLot: config.get(Keys.MIN_LOT_USDC).toUint32(),
            walletCap: config.get(Keys.WALLET_CAP_USDC).toUint64(),
            depthT1: config.get(Keys.DEPTH_T1_USDC).toUint64(),
            depthT2: config.get(Keys.DEPTH_T2_USDC).toUint64(),
            depthT3: config.get(Keys.DEPTH_T3_USDC).toUint64()
        });
    }

    // ================================================================ requests

    function requestOpen(uint32 marketId, int8 side, uint96 collateral, uint16 maxSlippageBps, uint64 deadline)
        external
        nonReentrant
        returns (uint64 orderId)
    {
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        orderId = _requestOpen(msg.sender, marketId, side, collateral, maxSlippageBps, deadline);
    }

    /// @notice Same as requestOpen with an EIP-2612 permit in one transaction (PRD F2). A failed permit
    /// is ignored when the allowance already covers the amount, so a front-run permit can't grief.
    function requestOpenWithPermit(
        uint32 marketId,
        int8 side,
        uint96 collateral,
        uint16 maxSlippageBps,
        uint64 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint64 orderId) {
        _permit(collateral, permitDeadline, v, r, s);
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        orderId = _requestOpen(msg.sender, marketId, side, collateral, maxSlippageBps, deadline);
    }

    /// @notice Underrated (dir = +1): long .WORK and short .HYPE. All talk (dir = −1): the reverse.
    /// Each leg takes half the collateral; both fill or both are refunded.
    function requestSpread(uint32 blokeId, int8 dir, uint96 collateral, uint16 maxSlippageBps, uint64 deadline)
        external
        nonReentrant
        returns (uint64 workOrder, uint64 hypeOrder)
    {
        if (dir != 1 && dir != -1) revert BadSide();
        usdc.safeTransferFrom(msg.sender, address(this), collateral);
        uint96 half = collateral / 2;
        workOrder = _requestOpen(msg.sender, _marketId(blokeId, 2), dir, half, maxSlippageBps, deadline);
        hypeOrder = _requestOpen(msg.sender, _marketId(blokeId, 1), -dir, collateral - half, maxSlippageBps, deadline);
        _orders[workOrder].partner = hypeOrder;
        _orders[hypeOrder].partner = workOrder;
        emit SpreadLinked(workOrder, hypeOrder);
    }

    function requestClose(uint64 lotId, uint16 maxSlippageBps) external returns (uint64 orderId) {
        orderId = _requestClose(lotId, maxSlippageBps);
    }

    function requestCloseGroup(uint64 groupId, uint16 maxSlippageBps) external returns (uint64 a, uint64 b) {
        uint64[2] memory ls = groupLots[groupId];
        if (_lots[ls[0]].status == LotStatus.Open) a = _requestClose(ls[0], maxSlippageBps);
        if (_lots[ls[1]].status == LotStatus.Open) b = _requestClose(ls[1], maxSlippageBps);
    }

    function cancel(uint64 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.owner != msg.sender) revert NotOwner();
        if (o.status != OrderStatus.Pending) revert AlreadyFinal();
        if (block.timestamp < o.requestedAt + uint256(params.cancelAfter)) revert CancelTooEarly();
        _refund(orderId, OrderStatus.Cancelled);
        uint64 partner = o.partner;
        if (partner != 0 && _orders[partner].status == OrderStatus.Pending) _refund(partner, OrderStatus.Cancelled);
    }

    function expire(uint64[] calldata orderIds) external nonReentrant {
        if (orderIds.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < orderIds.length; ++i) {
            Order storage o = _orders[orderIds[i]];
            if (o.status != OrderStatus.Pending || block.timestamp <= o.deadline) {
                emit OrderSkipped(orderIds[i]);
                continue;
            }
            _refund(orderIds[i], OrderStatus.Expired);
        }
    }

    // ================================================================ settlement

    /// @notice Fills or rejects each pending order whose request predates the latest push (I7).
    /// Orders waiting on a newer push, fresh data or a lag to clear stay pending.
    function settle(uint64[] calldata orderIds) external nonReentrant {
        if (orderIds.length > MAX_BATCH) revert BatchTooLarge();
        uint64 seq = oracle.lastSeq();
        uint256 capBaseWad = pool.capBase() * USDC_TO_WAD;
        for (uint256 i; i < orderIds.length; ++i) {
            uint64 id = orderIds[i];
            Order storage o = _orders[id];
            if (o.status != OrderStatus.Pending) {
                emit OrderSkipped(id);
                continue;
            }
            if (block.timestamp > o.deadline) {
                _refund(id, OrderStatus.Expired);
                if (o.partner != 0 && _orders[o.partner].status == OrderStatus.Pending) {
                    _refund(o.partner, OrderStatus.Expired);
                }
                continue;
            }
            if (seq <= o.seqAtRequest) continue;
            if (o.kind == Kind.Open) {
                if (o.partner != 0) _settleSpread(id, o.partner, seq, capBaseWad);
                else _settleOpen(id, capBaseWad);
            } else {
                _settleClose(id);
            }
        }
    }

    /// @notice Closes lots whose equity at mark is ≤ 0. Payout 0; no premium impact (PRD §7.4).
    function exhaust(uint64[] calldata lotIds) external nonReentrant {
        if (lotIds.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < lotIds.length; ++i) {
            Lot storage l = _lots[lotIds[i]];
            if (l.status != LotStatus.Open) continue;
            Market storage m = _touch(l.marketId);
            if (!_freshTradable(m)) continue;
            (int256 pricePnl, int256 fundingPnl) = _pnlAt(l, m, PricingLib.mark(PricingLib.indexToWad(m.lastIndex), m.premium));
            int256 equity = int256(uint256(l.collateral) * USDC_TO_WAD) + pricePnl + fundingPnl;
            if (equity > 0) continue;
            uint256 c = l.collateral;
            _removeLot(lotIds[i], l, m, LotStatus.Exhausted, -int256(c * USDC_TO_WAD));
            usdc.safeTransfer(address(pool), c);
            emit LotClosed(lotIds[i], LotStatus.Exhausted, 0, pricePnl, fundingPnl, 0, 0, 0);
        }
    }

    /// @notice Closes lots whose gross profit at mark has reached the cap (amendment A5). Mirrors
    /// exhaustion: mark price, no premium impact, normal fee.
    function takeProfitCap(uint64[] calldata lotIds) external nonReentrant {
        if (lotIds.length > MAX_BATCH) revert BatchTooLarge();
        uint256 maxProfitBps = uint256(params.maxProfitBps);
        for (uint256 i; i < lotIds.length; ++i) {
            Lot storage l = _lots[lotIds[i]];
            if (l.status != LotStatus.Open) continue;
            Market storage m = _touch(l.marketId);
            if (!_freshTradable(m)) continue;
            uint256 markPx = PricingLib.mark(PricingLib.indexToWad(m.lastIndex), m.premium);
            (int256 pricePnl, int256 fundingPnl) = _pnlAt(l, m, markPx);
            if (pricePnl + fundingPnl < int256(uint256(l.collateral) * USDC_TO_WAD * maxProfitBps / 10_000)) continue;
            _closeLot(lotIds[i], l, m, markPx, pricePnl, fundingPnl, true, LotStatus.ProfitCapped);
        }
    }

    /// @notice Settles lots on SettleOnly markets at the fixed price: zero premium, no fee, credited to
    /// `claimable` so one failing receiver can't grief the batch (PRD §7.5).
    function settleDelisted(uint64[] calldata lotIds) external nonReentrant {
        if (lotIds.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < lotIds.length; ++i) {
            Lot storage l = _lots[lotIds[i]];
            if (l.status != LotStatus.Open) continue;
            Market storage m = _markets[l.marketId];
            if (m.status != Status.SettleOnly) continue;
            uint256 px = uint256(PricingLib.indexToWad(m.settleIndex));
            (int256 pricePnl, int256 fundingPnl) = _pnlAt(l, m, px);
            _closeLot(lotIds[i], l, m, px, pricePnl, fundingPnl, false, LotStatus.Settled);
            if (m.openLots == 0) {
                m.status = Status.Settled;
                emit MarketStatusChanged(l.marketId, Status.Settled, m.settleIndex);
            }
        }
    }

    /// @notice Accrues premium decay and funding. The keeper calls this every 5 minutes.
    function poke(uint32[] calldata marketIds) external {
        if (marketIds.length > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i; i < marketIds.length; ++i) {
            if (_markets[marketIds[i]].status == Status.None) continue;
            Market storage m = _touch(marketIds[i]);
            emit FundingAccrued(marketIds[i], m.fundingIndex, m.premium);
        }
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Pays an IOU once the pool is recapitalised (only reachable beyond a credit event).
    function claimIou() external nonReentrant {
        uint256 owed = iou[msg.sender];
        if (owed == 0) revert NothingToClaim();
        uint256 sent = pool.cover(owed);
        iou[msg.sender] = owed - sent;
        if (sent > 0) usdc.safeTransfer(msg.sender, sent);
        emit Claimed(msg.sender, sent);
    }

    // ================================================================ status

    function onListed(uint32 blokeId, uint8 tier) external {
        if (msg.sender != address(registry)) revert NotRegistry();
        for (uint8 leg; leg < 3; ++leg) {
            uint32 id = _marketId(blokeId, leg);
            Market storage m = _markets[id];
            m.status = Status.Shadow;
            m.tier = tier;
            m.blokeId = blokeId;
            m.leg = leg;
            m.ts = uint64(block.timestamp);
            emit MarketCreated(id, blokeId, leg, tier);
        }
    }

    function onBlokeStatus(uint32 blokeId, IBlokeRegistry.Status s) external {
        if (msg.sender != address(registry)) revert NotRegistry();
        if (s == IBlokeRegistry.Status.Live) {
            for (uint8 leg; leg < 3; ++leg) _setStatus(_marketId(blokeId, leg), Status.Live, 0);
        } else if (s == IBlokeRegistry.Status.DelistPending) {
            for (uint8 leg; leg < 3; ++leg) _setStatus(_marketId(blokeId, leg), Status.ReduceOnly, 0);
        } else if (s == IBlokeRegistry.Status.Delisted) {
            (uint32 b, uint32 h, uint32 w) = registry.settlePrice(blokeId);
            _setStatus(_marketId(blokeId, 0), Status.SettleOnly, b);
            _setStatus(_marketId(blokeId, 1), Status.SettleOnly, h);
            _setStatus(_marketId(blokeId, 2), Status.SettleOnly, w);
        } else if (s == IBlokeRegistry.Status.Shadow) {
            for (uint8 leg; leg < 3; ++leg) _setStatus(_marketId(blokeId, leg), Status.Shadow, 0);
        }
        // Graduated: markets keep pricing off the index (PRD §10.5).
    }

    /// @notice ADMIN: Live ↔ ReduceOnly (e.g. pool stop conditions before P2 automates them).
    function setStatus(uint32 marketId, Status s) external restricted {
        Status cur = _markets[marketId].status;
        bool ok = (cur == Status.Live && s == Status.ReduceOnly) || (cur == Status.ReduceOnly && s == Status.Live)
            || (cur == Status.Frozen && (s == Status.Live || s == Status.ReduceOnly));
        if (!ok) revert BadStatusTransition();
        _touch(marketId);
        if (cur == Status.Frozen) _markets[marketId].frozenAt = 0;
        _setStatus(marketId, s, 0);
    }

    /// @notice GUARDIAN: freeze a market. Snapshots the 60-minute TWAP as the price it settles at if
    /// the freeze expires (72 h → SettleOnly).
    function freeze(uint32 marketId) external restricted {
        Market storage m = _touch(marketId);
        if (m.status != Status.Live && m.status != Status.ReduceOnly) revert BadStatusTransition();
        m.frozenAt = uint64(block.timestamp);
        uint32 twap = oracle.twap(m.blokeId, IHumanIndexOracle.Leg(m.leg), DELIST_TWAP_SEC);
        _setStatus(marketId, Status.Frozen, twap == 0 ? m.lastIndex : twap);
    }

    /// @notice Anyone: a freeze older than FREEZE_MAX_SEC becomes SettleOnly at the snapshot.
    function expireFreeze(uint32 marketId) external {
        Market storage m = _markets[marketId];
        if (m.status != Status.Frozen || block.timestamp < m.frozenAt + uint256(params.freezeMax)) {
            revert FreezeNotExpired();
        }
        _setStatus(marketId, Status.SettleOnly, m.settleIndex);
    }

    /// @notice GUARDIAN sets, ADMIN clears (separate selectors in the AccessManager).
    function enableGlobalReduceOnly() external restricted {
        globalReduceOnly = true;
        emit GlobalReduceOnly(true);
    }

    function disableGlobalReduceOnly() external restricted {
        globalReduceOnly = false;
        emit GlobalReduceOnly(false);
    }

    // ================================================================ views

    function market(uint32 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function order(uint64 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function lot(uint64 lotId) external view returns (Lot memory) {
        return _lots[lotId];
    }

    function marketIdOf(uint32 blokeId, uint8 leg) external pure returns (uint32) {
        return _marketId(blokeId, leg);
    }

    /// @notice Estimated fill for an open of `collateral` at the current index and decayed premium.
    function quote(uint32 marketId, int8 side, uint96 collateral)
        external
        view
        returns (uint256 fillPrice, int256 premiumAfter, uint256 markPrice)
    {
        Market storage m = _markets[marketId];
        (uint32 idx,,,) = oracle.read(m.blokeId, IHumanIndexOracle.Leg(m.leg));
        int256 iw = PricingLib.indexToWad(idx);
        int256 p = PricingLib.decayed(m.premium, block.timestamp - m.ts, uint256(params.halfLife));
        premiumAfter = PricingLib.premiumAfter(p, side, uint256(collateral) * USDC_TO_WAD, _depthWad(m.tier), _clamp());
        fillPrice = PricingLib.fillPrice(iw, p, premiumAfter, side);
        markPrice = PricingLib.mark(iw, p);
    }

    /// @notice Lot equity at the current mark (stored funding index; a poke refreshes it).
    function lotView(uint64 lotId)
        external
        view
        returns (int256 equity, int256 pricePnl, int256 fundingPnl, bool exhausted)
    {
        Lot storage l = _lots[lotId];
        Market storage m = _markets[l.marketId];
        (uint32 idx,,,) = oracle.read(m.blokeId, IHumanIndexOracle.Leg(m.leg));
        int256 p = PricingLib.decayed(m.premium, block.timestamp - m.ts, uint256(params.halfLife));
        (pricePnl, fundingPnl) = _pnlAt(l, m, PricingLib.mark(PricingLib.indexToWad(idx), p));
        equity = int256(uint256(l.collateral) * USDC_TO_WAD) + pricePnl + fundingPnl;
        exhausted = equity <= 0;
    }

    /// @notice Everything the pool crank needs from one market in one call (amendment A9): cumulative
    /// realised trader gross (WAD), cumulative retained fees (6 dp) and traders' unrealised gross (WAD).
    function poolView(uint32 marketId) external view returns (int256 realizedGross, uint256 feeRetained, int256 unrealized) {
        Market storage m = _markets[marketId];
        return (m.realizedGrossAcc, m.feeRetainedAcc, this.tradersUnrealized(marketId));
    }

    /// @notice Traders' unrealised gross PnL on a market (WAD tUSDC); the pool's U is its negative
    /// (PRD §8.2). Computed from aggregates: net·P − Σ s·u·Pentry − fundingAgg.
    function tradersUnrealized(uint32 marketId) external view returns (int256) {
        Market storage m = _markets[marketId];
        uint256 px = m.status == Status.SettleOnly || m.status == Status.Frozen
            ? uint256(PricingLib.indexToWad(m.settleIndex))
            : PricingLib.mark(PricingLib.indexToWad(m.lastIndex), m.premium);
        int256 fundingAgg = (int256(m.fundingIndex) * m.net) / WAD - m.sumSUF;
        return (m.net * int256(px)) / WAD - m.sumSUP - fundingAgg;
    }

    // ================================================================ internals: requests

    function _requestOpen(
        address owner,
        uint32 marketId,
        int8 side,
        uint96 collateral,
        uint16 maxSlippageBps,
        uint64 deadline
    ) internal returns (uint64 orderId) {
        Market storage m = _markets[marketId];
        if (m.status != Status.Live && m.status != Status.ReduceOnly) revert MarketNotTradable();
        if (side != 1 && side != -1) revert BadSide();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        if (collateral < uint256(params.minLot)) revert BelowMinLot();
        if (registry.isLinked(m.blokeId, owner)) revert SelfTrade();

        Exposure storage e = exposure[owner][marketId];
        if (e.side != 0 && e.side != side) revert OppositeSideOpen();
        if (uint256(e.lots) + e.pendingOpens >= uint256(params.maxLots)) revert TooManyLots();
        if (uint256(e.collateral) + collateral > uint256(params.walletCap)) revert WalletCapExceeded();
        e.side = side;
        e.pendingOpens += 1;
        e.collateral += collateral;

        orderId = _newOrder(owner, marketId, m, side, Kind.Open, maxSlippageBps, deadline);
        _orders[orderId].collateral = collateral;
        Order storage o = _orders[orderId];
        emit OrderRequested(orderId, owner, marketId, side, collateral, Kind.Open, o.seqAtRequest, o.deadline, 0);
    }

    function _requestClose(uint64 lotId, uint16 maxSlippageBps) internal returns (uint64 orderId) {
        Lot storage l = _lots[lotId];
        if (l.owner != msg.sender) revert NotOwner();
        if (l.status != LotStatus.Open) revert AlreadyFinal();
        if (l.closePending) revert ClosePending();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        Market storage m = _markets[l.marketId];
        if (m.status != Status.Live && m.status != Status.ReduceOnly) revert MarketNotTradable();
        l.closePending = true;
        orderId = _newOrder(msg.sender, l.marketId, m, -l.side, Kind.Close, maxSlippageBps, 0);
        _orders[orderId].lotId = lotId;
        Order storage o = _orders[orderId];
        emit OrderRequested(orderId, msg.sender, l.marketId, l.side, 0, Kind.Close, o.seqAtRequest, o.deadline, lotId);
    }

    /// @dev `side` here is the trade direction for refMark (closing a long sells).
    function _newOrder(
        address owner,
        uint32 marketId,
        Market storage m,
        int8 dir,
        Kind kind,
        uint16 maxSlippageBps,
        uint64 deadline
    ) internal returns (uint64 orderId) {
        if (pendingCount[owner] >= uint256(params.maxPending)) revert TooManyPending();
        pendingCount[owner] += 1;
        if (deadline == 0) deadline = uint64(block.timestamp + uint256(params.defaultDeadline));
        if (deadline <= block.timestamp || deadline > block.timestamp + uint256(params.maxDeadline)) {
            revert DeadlineTooFar();
        }
        orderId = (uint64(marketId) << 32) | ++m.orderCount; // per-market ids (A9)
        (uint32 idx,,,) = oracle.read(m.blokeId, IHumanIndexOracle.Leg(m.leg));
        int256 p = PricingLib.decayed(m.premium, block.timestamp - m.ts, uint256(params.halfLife));
        _orders[orderId] = Order({
            owner: owner,
            marketId: marketId,
            side: kind == Kind.Open ? dir : -dir,
            kind: kind,
            status: OrderStatus.Pending,
            maxSlippageBps: maxSlippageBps == 0 ? 100 : maxSlippageBps,
            collateral: 0,
            seqAtRequest: oracle.lastSeq(),
            requestedAt: uint64(block.timestamp),
            deadline: deadline,
            lotId: 0,
            partner: 0,
            refMark: uint128(PricingLib.mark(PricingLib.indexToWad(idx), p))
        });
    }

    function _refund(uint64 orderId, OrderStatus how) internal {
        Order storage o = _orders[orderId];
        o.status = how;
        pendingCount[o.owner] -= 1;
        if (o.kind == Kind.Open) {
            Exposure storage e = exposure[o.owner][o.marketId];
            e.pendingOpens -= 1;
            e.collateral -= o.collateral;
            if (e.lots == 0 && e.pendingOpens == 0) e.side = 0;
            _pay(o.owner, o.collateral);
        } else {
            _lots[o.lotId].closePending = false;
        }
        if (how == OrderStatus.Cancelled) emit OrderCancelled(orderId);
        else if (how == OrderStatus.Expired) emit OrderExpired(orderId);
    }

    function _reject(uint64 orderId, Reason reason) internal {
        _refund(orderId, OrderStatus.Rejected);
        emit OrderRejected(orderId, reason);
    }

    // ================================================================ internals: fills

    function _settleOpen(uint64 id, uint256 capBaseWad) internal {
        Order storage o = _orders[id];
        Market storage m = _touch(o.marketId);
        Fill memory f = _evalOpen(o, m, capBaseWad);
        if (f.reason == Reason.Stale) return; // stays pending until fresh data or expiry
        if (f.reason != Reason.None) return _reject(id, f.reason);
        _commitOpen(id, o, m, f, 0);
    }

    function _settleSpread(uint64 a, uint64 b, uint64 seq, uint256 capBaseWad) internal {
        Order storage oa = _orders[a];
        Order storage ob = _orders[b];
        if (ob.status != OrderStatus.Pending || seq <= ob.seqAtRequest) return;
        Market storage ma = _touch(oa.marketId);
        Market storage mb = _touch(ob.marketId);
        Fill memory fa = _evalOpen(oa, ma, capBaseWad);
        Fill memory fb = _evalOpen(ob, mb, capBaseWad);
        if (fa.reason == Reason.Stale || fb.reason == Reason.Stale) return;
        if (fa.reason != Reason.None || fb.reason != Reason.None) {
            _reject(a, fa.reason != Reason.None ? fa.reason : Reason.Group);
            _reject(b, fb.reason != Reason.None ? fb.reason : Reason.Group);
            return;
        }
        uint64 groupId = a < b ? a : b;
        uint64 la = _commitOpen(a, oa, ma, fa, groupId);
        uint64 lb = _commitOpen(b, ob, mb, fb, groupId);
        groupLots[groupId] = [la, lb];
    }

    function _evalOpen(Order storage o, Market storage m, uint256 capBaseWad) internal view returns (Fill memory f) {
        (uint32 idx, bool fresh, int8 lag) = _index(m);
        if (!fresh) {
            f.reason = Reason.Stale;
            return f;
        }
        int256 iw = PricingLib.indexToWad(idx);
        int8 dir = o.side;
        uint256 notional = uint256(o.collateral) * USDC_TO_WAD;
        f.premiumAfter = PricingLib.premiumAfter(m.premium, dir, notional, _depthWad(m.tier), _clamp());
        f.price = PricingLib.fillPrice(iw, m.premium, f.premiumAfter, dir);
        f.units = (notional * 1e18) / f.price;

        int256 newNet = m.net + dir * int256(f.units);
        bool increases = _abs(newNet) > _abs(m.net);

        if (m.status != Status.Live && !(m.status == Status.ReduceOnly && !increases)) {
            f.reason = Reason.Status;
        } else if (globalReduceOnly && increases) {
            f.reason = Reason.Status;
        } else if (dir * lag > 0) {
            f.reason = Reason.Lagging; // A1: would profit from the known catch-up
        } else if (_slipped(f.price, o.refMark, o.maxSlippageBps)) {
            f.reason = Reason.Slippage;
        } else if (increases) {
            f.reason = _capCheck(m, newNet, iw, capBaseWad);
        }
    }

    function _capCheck(Market storage m, int256 newNet, int256 iw, uint256 capBaseWad) internal view returns (Reason) {
        uint256 newAbs = (_abs(newNet) * uint256(iw)) / 1e18;
        if (newAbs * 10_000 > capBaseWad * uint256(params.netCapMarketBps)) return Reason.NetCap;
        uint256 newGlobal = globalNetAbs - m.netAbsCached + newAbs;
        if (newGlobal * 10_000 > capBaseWad * uint256(params.netCapGlobalBps)) return Reason.GlobalCap;
        int256 w = _familyWeight(m.leg);
        if (w != 0) {
            int256 newFam = hypeFamily - m.familyCached + (((newNet * iw) / WAD) * w) / WAD;
            if (_abs(newFam) > _abs(hypeFamily) && _abs(newFam) * 10_000 > capBaseWad * uint256(params.netCapFamilyBps)) {
                return Reason.FamilyCap;
            }
        }
        return Reason.None;
    }

    function _commitOpen(uint64 id, Order storage o, Market storage m, Fill memory f, uint64 groupId)
        internal
        returns (uint64 lotId)
    {
        o.status = OrderStatus.Filled;
        pendingCount[o.owner] -= 1;
        Exposure storage e = exposure[o.owner][o.marketId];
        e.pendingOpens -= 1;
        e.lots += 1;

        lotId = (uint64(o.marketId) << 32) | ++m.lotCount;
        int256 su = o.side * int256(f.units);
        _lots[lotId] = Lot({
            owner: o.owner,
            marketId: o.marketId,
            side: o.side,
            status: LotStatus.Open,
            closePending: false,
            collateral: o.collateral,
            units: uint128(f.units),
            entryPrice: uint128(f.price),
            entryIndex: m.lastIndex,
            openedAt: uint64(block.timestamp),
            groupId: groupId,
            fundingEntry: m.fundingIndex
        });
        m.net = (m.net + su).toInt128();
        m.sumSUP = (m.sumSUP + (su * int256(f.price)) / WAD).toInt128();
        m.sumSUF = (m.sumSUF + (su * m.fundingIndex) / WAD).toInt128();
        m.grossCollateral += o.collateral;
        m.openLots += 1;
        m.premium = f.premiumAfter.toInt64();
        _refreshAggregates(m);
        emit OrderFilled(id, lotId, f.price, m.lastIndex, f.premiumAfter);
    }

    function _settleClose(uint64 id) internal {
        Order storage o = _orders[id];
        Lot storage l = _lots[o.lotId];
        if (l.status != LotStatus.Open) return _reject(id, Reason.LotNotOpen);
        Market storage m = _touch(o.marketId);
        if (m.status == Status.Frozen) return; // stays pending
        if (m.status != Status.Live && m.status != Status.ReduceOnly) return _reject(id, Reason.Status);
        (uint32 idx, bool fresh, int8 lag) = _index(m);
        if (!fresh) return;
        int8 dir = -l.side;
        if (dir * lag > 0) {
            emit OrderDeferred(id, Reason.Lagging); // A1: closes wait for the catch-up instead
            return;
        }
        int256 iw = PricingLib.indexToWad(idx);
        uint256 notional = (uint256(l.units) * PricingLib.mark(iw, m.premium)) / 1e18;
        int256 pAfter = PricingLib.premiumAfter(m.premium, dir, notional, _depthWad(m.tier), _clamp());
        uint256 exitPx = PricingLib.fillPrice(iw, m.premium, pAfter, dir);
        if (_slipped(exitPx, o.refMark, o.maxSlippageBps)) return _reject(id, Reason.Slippage);

        o.status = OrderStatus.Filled;
        pendingCount[o.owner] -= 1;
        m.premium = pAfter.toInt64();
        (int256 pricePnl, int256 fundingPnl) = _pnlAt(l, m, exitPx);
        _closeLot(o.lotId, l, m, exitPx, pricePnl, fundingPnl, true, LotStatus.Closed);
        emit OrderFilled(id, o.lotId, exitPx, idx, pAfter);
    }

    /// @dev Shared close path: profit cap, fee split, cash movement between engine, pool and registry.
    function _closeLot(
        uint64 lotId,
        Lot storage l,
        Market storage m,
        uint256 exitPx,
        int256 pricePnl,
        int256 fundingPnl,
        bool chargeFee,
        LotStatus how
    ) internal {
        int256 cW = int256(uint256(l.collateral) * USDC_TO_WAD);
        int256 gross = pricePnl + fundingPnl;
        int256 cap = (cW * int256(uint256(params.maxProfitBps))) / 10_000;
        if (gross > cap) gross = cap; // A5
        uint256 feeWad = chargeFee && gross > 0 ? (uint256(gross) * uint256(params.closeFeeBps)) / 10_000 : 0;
        int256 payoutWad = cW + gross - int256(feeWad);
        uint256 payout = payoutWad > 0 ? uint256(payoutWad) / USDC_TO_WAD : 0; // rounds toward the pool
        uint256 fee = feeWad / USDC_TO_WAD;
        uint256 creatorFee = fee == 0 ? 0 : (fee * _creatorShareBps(m.blokeId)) / 10_000;

        address owner = l.owner;
        uint256 collateral = l.collateral;
        _removeLot(lotId, l, m, how, gross);
        m.feeRetainedAcc = (uint256(m.feeRetainedAcc) + fee - creatorFee).toUint128();
        m.creatorFeeAcc = (uint256(m.creatorFeeAcc) + creatorFee).toUint128();

        // Cash: the engine holds `collateral`; it owes `payout` to the trader and `creatorFee` to the
        // registry. If the pool can't cover (only beyond a credit event) the trader is paid first and
        // the rest becomes an IOU.
        uint256 need = payout + creatorFee;
        uint256 avail = need;
        if (need > collateral) {
            avail = collateral + pool.cover(need - collateral);
        } else if (collateral > need) {
            usdc.safeTransfer(address(pool), collateral - need);
        }
        uint256 paid = avail >= payout ? payout : avail;
        uint256 cf = avail - paid;
        if (cf > 0) {
            usdc.safeTransfer(address(registry), cf);
            registry.creditCreator(m.blokeId, cf);
        }
        if (paid < payout) {
            iou[owner] += payout - paid;
            emit IouRecorded(owner, payout - paid);
        }
        if (how == LotStatus.Settled) {
            claimable[owner] += paid;
            emit PayoutCredited(owner, paid);
        } else {
            _pay(owner, paid);
        }
        emit LotClosed(lotId, how, exitPx, pricePnl, fundingPnl, fee, creatorFee, payout);
    }

    function _removeLot(uint64, Lot storage l, Market storage m, LotStatus how, int256 gross) internal {
        int256 su = l.side * int256(uint256(l.units));
        m.net = (m.net - su).toInt128();
        m.sumSUP = (m.sumSUP - (su * int256(uint256(l.entryPrice))) / WAD).toInt128();
        m.sumSUF = (m.sumSUF - (su * l.fundingEntry) / WAD).toInt128();
        m.grossCollateral -= l.collateral;
        m.openLots -= 1;
        m.realizedGrossAcc = (m.realizedGrossAcc + gross).toInt128();
        l.status = how;
        Exposure storage e = exposure[l.owner][l.marketId];
        e.lots -= 1;
        e.collateral -= l.collateral;
        if (e.lots == 0 && e.pendingOpens == 0) e.side = 0;
        if (l.closePending) {
            l.closePending = false; // the pending close order will be rejected LotNotOpen
        }
        _refreshAggregates(m);
    }

    // ================================================================ internals: market state

    /// @dev Accrues premium decay, funding and OI·time to now, then refreshes the stored index.
    function _touch(uint32 marketId) internal returns (Market storage m) {
        m = _markets[marketId];
        (uint32 idx,,, bool isPaused) = oracle.read(m.blokeId, IHumanIndexOracle.Leg(m.leg));
        uint256 dt = block.timestamp - m.ts;
        if (dt > 0) {
            uint256 hl = uint256(params.halfLife);
            int256 p0 = m.premium;
            bool accrue = (m.status == Status.Live || m.status == Status.ReduceOnly) && !isPaused;
            if (accrue && m.lastIndex != 0) {
                m.fundingIndex = (int256(m.fundingIndex)
                    + PricingLib.fundingDelta(PricingLib.indexToWad(m.lastIndex), p0, dt, hl, uint256(params.kappaBpsPerHour)))
                    .toInt128();
            }
            m.premium = PricingLib.decayed(p0, dt, hl).toInt64();
            m.oiTimeAcc = (uint256(m.oiTimeAcc) + uint256(m.grossCollateral) * dt).toUint128();
            m.ts = uint64(block.timestamp);
        }
        if ((m.status == Status.Live || m.status == Status.ReduceOnly || m.status == Status.Shadow) && idx != 0) {
            m.lastIndex = idx;
        }
        _refreshAggregates(m);
    }

    function _refreshAggregates(Market storage m) internal {
        int256 iw = PricingLib.indexToWad(m.lastIndex);
        uint256 newAbs = (_abs(m.net) * uint256(iw)) / 1e18;
        globalNetAbs = globalNetAbs - m.netAbsCached + newAbs;
        m.netAbsCached = newAbs.toUint128();
        int256 w = _familyWeight(m.leg);
        if (w != 0) {
            int256 newFam = (((m.net * iw) / WAD) * w) / WAD;
            hypeFamily = hypeFamily - m.familyCached + newFam;
            m.familyCached = newFam.toInt128();
        }
    }

    function _setStatus(uint32 marketId, Status s, uint32 settleIndex) internal {
        Market storage m = _markets[marketId];
        if (m.status == Status.None) return;
        if (s == Status.SettleOnly || s == Status.Frozen) {
            _touch(marketId); // accrue funding up to the transition, then stop
            m.settleIndex = settleIndex;
        }
        m.status = s;
        if (s == Status.SettleOnly && m.openLots == 0) m.status = Status.Settled;
        emit MarketStatusChanged(marketId, m.status, settleIndex);
    }

    function _index(Market storage m) internal view returns (uint32 idx, bool fresh, int8 lag) {
        bool isPaused;
        (idx, fresh, lag, isPaused) = oracle.read(m.blokeId, IHumanIndexOracle.Leg(m.leg));
        fresh = fresh && idx != 0 && !isPaused;
    }

    function _freshTradable(Market storage m) internal view returns (bool) {
        if (m.status != Status.Live && m.status != Status.ReduceOnly) return false;
        (, bool fresh,) = _index(m);
        return fresh;
    }

    function _pnlAt(Lot storage l, Market storage m, uint256 px) internal view returns (int256 pricePnl, int256 fundingPnl) {
        int256 su = l.side * int256(uint256(l.units));
        pricePnl = (su * (int256(px) - int256(uint256(l.entryPrice)))) / WAD;
        fundingPnl = -(su * (m.fundingIndex - l.fundingEntry)) / WAD;
    }

    /// @dev 15% of the fee, or 25% while the person's Skin is at least MIN_SKIN (PRD §6.3, §9.4).
    function _creatorShareBps(uint32 blokeId) internal view returns (uint256) {
        return pool.hasSkin(blokeId) ? uint256(params.creatorShareSkinBps) : uint256(params.creatorShareBps);
    }

    function _depthWad(uint8 tier) internal view returns (uint256) {
        Params storage p = params;
        return uint256(tier == 1 ? p.depthT1 : tier == 2 ? p.depthT2 : p.depthT3) * USDC_TO_WAD;
    }

    function _clamp() internal view returns (int256) {
        return int256(uint256(params.clampBps)) * 1e14;
    }

    function _slipped(uint256 px, uint256 ref, uint256 bps) internal pure returns (bool) {
        uint256 diff = px > ref ? px - ref : ref - px;
        return diff * 10_000 > ref * bps;
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        // Payouts fall back to `claimable` if the transfer fails (e.g. a blacklisting token on mainnet).
        (bool ok, bytes memory ret) =
            address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            claimable[to] += amount;
            emit PayoutCredited(to, amount);
        }
    }

    function _permit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) internal {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), amount, deadline, v, r, s) {}
        catch {
            // Already used (e.g. front-run) — fine if the allowance is there; transferFrom decides.
        }
    }

    function _familyWeight(uint8 leg) internal pure returns (int256) {
        return leg == 1 ? WAD : leg == 0 ? BLEND_HYPE_WEIGHT : int256(0);
    }

    function _marketId(uint32 blokeId, uint8 leg) internal pure returns (uint32) {
        return blokeId * 3 + leg;
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }
}
