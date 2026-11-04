// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IBlokePool} from "../interfaces/IBlokePool.sol";
import {IBlokeRegistry} from "../interfaces/IBlokeRegistry.sol";
import {IProtocolConfig} from "../interfaces/IProtocolConfig.sol";
import {Keys} from "../config/Keys.sol";
import {PoolShare} from "./PoolShare.sol";

interface IEnginePoolSide {
    function poolView(uint32 marketId) external view returns (int256 realizedGross, uint256 feeRetained, int256 unrealized);
    function poke(uint32[] calldata marketIds) external;
    function enableGlobalReduceOnly() external;
}

/// @title BlokePool
/// @notice The counterparty to every trade (PRD §8). Two decks: Floor (senior, fixed rate, fixed term) and
/// Edge (junior, first loss after Skin), plus the Reserve, the treasury and per-person Skin.
///
/// Each hourly epoch the crank measures the pool's mark-to-market result G from the engine's per-market
/// totals (amendment A9: nothing is written to the pool per fill), absorbs realised losses into Skin, and
/// runs the waterfall: protocol fee → Floor accrual → Edge residual. Losses hit Edge, then the Reserve,
/// then Floor principal (a credit event). Edge deposits and redemptions settle in epoch buckets at the
/// post-waterfall NAV, so nobody enters or exits at a stale price.
///
/// Simplifications vs the PRD, both documented in docs/prd/amendments.md A15:
///  - The unfilled part of a redemption bucket is handed back as shares at claim (re-request next epoch)
///    instead of rolling automatically.
///  - One Floor series is active at a time; the next opens for subscription while it runs.
contract BlokePool is IBlokePool, AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant YEAR = 365 days;
    uint256 private constant MAX_EPOCH_DT = 24 hours;
    uint256 private constant VIRTUAL_SHARES = 1e6; // first-depositor inflation guard (PRD §8.5)
    uint256 private constant WAD_TO_USDC = 1e12;

    enum SeriesState {
        None,
        Subscribing,
        Active,
        Matured
    }

    struct Series {
        uint16 rateBps;
        uint64 start;
        uint64 end;
        SeriesState state;
        uint256 subscribed; // escrowed subscriptions
        uint256 principal; // filled at start
        uint256 value; // principal + accrued − impairment (live while Active, fixed once Matured)
        uint256 impaired;
        PoolShare token;
    }

    struct Bucket {
        uint256 depositAssets;
        uint256 redeemShares;
        uint256 sharesOut; // minted for deposits
        uint256 assetsOut; // paid for filled redemptions
        uint256 filledShares; // redemption shares actually burned
        bool processed;
    }

    IERC20 public immutable usdc;
    IProtocolConfig public immutable config;
    IBlokeRegistry public immutable registry;
    PoolShare public immutable edgeShares;
    IEnginePoolSide public engine;

    // ------------------------------------------------------------ balances (tUSDC, 6 dp)
    uint256 public edgeNav; // E
    uint256 public reserve; // R
    uint256 public treasury; // T, unswept
    uint256 public escrowed; // queued deposits, subscriptions, unclaimed refunds/redemptions, matured Floor
    mapping(uint32 => uint256) public skin;
    mapping(uint32 => uint64) public skinSince;
    mapping(uint32 => uint256) public skinWithdrawRequest;

    // ------------------------------------------------------------ epochs
    uint256 public epoch;
    uint64 public epochStart;
    int256 public lastRealized; // Σ realised trader gross (WAD)
    uint256 public lastFees; // Σ retained fees (6 dp)
    int256 public lastUnrealized; // Σ traders' unrealised gross (WAD)
    mapping(uint32 => int256) public lastRealizedByBloke;
    mapping(uint256 => Bucket) public buckets;
    mapping(uint256 => mapping(address => uint256)) public depositOf;
    mapping(uint256 => mapping(address => uint256)) public redeemOf;

    // ------------------------------------------------------------ Floor
    Series[] internal _series;
    uint256 public activeSeries; // index + 1, 0 = none
    uint256 public openSeries; // index + 1, 0 = none
    mapping(uint256 => mapping(address => uint256)) public subscriptionOf;

    // ------------------------------------------------------------ flags
    bool public floorPaused; // subordination below the floor
    bool public creditEvent;

    event EpochSettled(
        uint256 indexed epoch, int256 g, uint256 fee, uint256 dReserve, uint256 dTreasury, uint256 floorAccrual, int256 dEdge, uint256 skinAbsorbed, uint256 impairment
    );
    event DepositRequested(uint256 indexed epoch, address indexed who, uint256 assets);
    event RedeemRequested(uint256 indexed epoch, address indexed who, uint256 shares);
    event RequestCancelled(uint256 indexed epoch, address indexed who, uint256 assets, uint256 shares);
    event DepositClaimed(uint256 indexed epoch, address indexed who, uint256 shares);
    event RedeemClaimed(uint256 indexed epoch, address indexed who, uint256 assets, uint256 sharesReturned);
    event SeriesCreated(uint256 indexed id, uint16 rateBps, uint64 start, uint64 end, address token);
    event Subscribed(uint256 indexed id, address indexed who, uint256 amount);
    event SeriesStarted(uint256 indexed id, uint256 principal, uint256 subscribed);
    event SeriesMatured(uint256 indexed id, uint256 value);
    event SubscriptionClaimed(uint256 indexed id, address indexed who, uint256 shares, uint256 refund);
    event FloorRedeemed(uint256 indexed id, address indexed who, uint256 shares, uint256 assets);
    event SkinPosted(uint32 indexed blokeId, uint256 amount, uint256 total);
    event SkinAbsorbed(uint32 indexed blokeId, uint256 amount);
    event SkinWithdrawRequested(uint32 indexed blokeId, uint256 amount);
    event SkinWithdrawn(uint32 indexed blokeId, address to, uint256 amount, uint256 locked);
    event StopCondition(bytes32 kind, bool on);
    event CreditEvent(uint256 impairment);
    event Covered(uint256 requested, uint256 sent);
    event TreasurySwept(address to, uint256 amount);
    event EngineSet(address engine);

    error NotEngine();
    error EngineAlreadySet();
    error EpochNotOver();
    error NothingToClaim();
    error BucketClosed();
    error SeriesNotOpen();
    error NotMatured();
    error RateAboveCap();
    error SubscriptionsPaused();
    error NotClaimedWallet();
    error InsufficientSkin();
    error ZeroAmount();

    constructor(address authority, IERC20 usdc_, IProtocolConfig config_, IBlokeRegistry registry_) AccessManaged(authority) {
        usdc = usdc_;
        config = config_;
        registry = registry_;
        // 12 decimals: the 1e6 virtual-share offset mints 1e6 share units per tUSDC unit, so 1 EDGE ≈ 1 tUSDC.
        edgeShares = new PoolShare("BLOKE Edge", "EDGE", 12);
    }

    function setEngine(address engine_) external restricted {
        if (address(engine) != address(0)) revert EngineAlreadySet();
        engine = IEnginePoolSide(engine_);
        emit EngineSet(engine_);
    }

    // ================================================================ engine side

    /// @notice E + R: first-loss capital behind every exposure cap (PRD §6.4).
    function capBase() external view returns (uint256) {
        return edgeNav + reserve;
    }

    function hasSkin(uint32 blokeId) external view returns (bool) {
        return skin[blokeId] >= config.get(Keys.MIN_SKIN_USDC);
    }

    /// @notice Funds a winning payout from free cash. Escrow (queues, subscriptions, matured Floor) is never used.
    function cover(uint256 amount) external nonReentrant returns (uint256 sent) {
        if (msg.sender != address(engine)) revert NotEngine();
        uint256 bal = usdc.balanceOf(address(this));
        uint256 free = bal > escrowed ? bal - escrowed : 0;
        sent = amount > free ? free : amount;
        if (sent > 0) usdc.safeTransfer(address(engine), sent);
        emit Covered(amount, sent);
    }

    // ================================================================ Edge (junior)

    function requestDeposit(uint256 assets) external nonReentrant {
        if (assets == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        escrowed += assets;
        buckets[epoch].depositAssets += assets;
        depositOf[epoch][msg.sender] += assets;
        emit DepositRequested(epoch, msg.sender, assets);
    }

    function requestRedeem(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        IERC20(address(edgeShares)).safeTransferFrom(msg.sender, address(this), shares);
        buckets[epoch].redeemShares += shares;
        redeemOf[epoch][msg.sender] += shares;
        emit RedeemRequested(epoch, msg.sender, shares);
    }

    /// @notice Cancels this epoch's requests before the crank.
    function cancelRequest() external nonReentrant {
        uint256 a = depositOf[epoch][msg.sender];
        uint256 s = redeemOf[epoch][msg.sender];
        if (a == 0 && s == 0) revert NothingToClaim();
        depositOf[epoch][msg.sender] = 0;
        redeemOf[epoch][msg.sender] = 0;
        buckets[epoch].depositAssets -= a;
        buckets[epoch].redeemShares -= s;
        escrowed -= a;
        if (a > 0) usdc.safeTransfer(msg.sender, a);
        if (s > 0) IERC20(address(edgeShares)).safeTransfer(msg.sender, s);
        emit RequestCancelled(epoch, msg.sender, a, s);
    }

    function claimDeposit(uint256 ep) external nonReentrant {
        Bucket storage b = buckets[ep];
        uint256 a = depositOf[ep][msg.sender];
        if (!b.processed || a == 0) revert NothingToClaim();
        depositOf[ep][msg.sender] = 0;
        uint256 shares = (b.sharesOut * a) / b.depositAssets;
        IERC20(address(edgeShares)).safeTransfer(msg.sender, shares);
        emit DepositClaimed(ep, msg.sender, shares);
    }

    function claimRedeem(uint256 ep) external nonReentrant {
        Bucket storage b = buckets[ep];
        uint256 s = redeemOf[ep][msg.sender];
        if (!b.processed || s == 0) revert NothingToClaim();
        redeemOf[ep][msg.sender] = 0;
        uint256 assets = (b.assetsOut * s) / b.redeemShares;
        uint256 filled = (b.filledShares * s) / b.redeemShares;
        uint256 back = s - filled;
        escrowed -= assets;
        if (assets > 0) usdc.safeTransfer(msg.sender, assets);
        if (back > 0) IERC20(address(edgeShares)).safeTransfer(msg.sender, back);
        emit RedeemClaimed(ep, msg.sender, assets, back);
    }

    /// @notice tUSDC value of `shares` at the current NAV (virtual offset included).
    function edgeValue(uint256 shares) public view returns (uint256) {
        return (shares * (edgeNav + 1)) / (edgeShares.totalSupply() + VIRTUAL_SHARES);
    }

    // ================================================================ Floor (senior)

    /// @notice ADMIN: opens the next series for subscription. Rate is fixed for its life (PRD §16.3).
    function createSeries(uint16 rateBps, uint64 start, uint64 term) external restricted returns (uint256 id) {
        if (rateBps > config.get(Keys.FLOOR_RATE_CAP_BPS)) revert RateAboveCap();
        if (openSeries != 0) revert SeriesNotOpen();
        id = _series.length;
        string memory n = Strings.toString(id + 1);
        PoolShare token = new PoolShare(string.concat("BLOKE Floor ", n), string.concat("FLOOR-", n), 6);
        _series.push(Series(rateBps, start, start + term, SeriesState.Subscribing, 0, 0, 0, 0, token));
        openSeries = id + 1;
        emit SeriesCreated(id, rateBps, start, start + term, address(token));
    }

    function subscribe(uint256 id, uint256 amount) external nonReentrant {
        Series storage s = _series[id];
        if (s.state != SeriesState.Subscribing || block.timestamp >= s.start) revert SeriesNotOpen();
        if (floorPaused || creditEvent) revert SubscriptionsPaused();
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        escrowed += amount;
        s.subscribed += amount;
        subscriptionOf[id][msg.sender] += amount;
        emit Subscribed(id, msg.sender, amount);
    }

    function cancelSubscription(uint256 id) external nonReentrant {
        Series storage s = _series[id];
        if (s.state != SeriesState.Subscribing) revert SeriesNotOpen();
        uint256 a = subscriptionOf[id][msg.sender];
        if (a == 0) revert NothingToClaim();
        subscriptionOf[id][msg.sender] = 0;
        s.subscribed -= a;
        escrowed -= a;
        usdc.safeTransfer(msg.sender, a);
    }

    /// @notice After the start: mints series tokens for the filled share and refunds the rest.
    function claimSubscription(uint256 id) external nonReentrant {
        Series storage s = _series[id];
        if (s.state == SeriesState.Subscribing || s.state == SeriesState.None) revert SeriesNotOpen();
        uint256 a = subscriptionOf[id][msg.sender];
        if (a == 0) revert NothingToClaim();
        subscriptionOf[id][msg.sender] = 0;
        uint256 shares = s.subscribed == 0 ? 0 : (a * s.principal) / s.subscribed;
        uint256 refund = a - shares;
        if (shares > 0) s.token.mint(msg.sender, shares);
        if (refund > 0) {
            escrowed -= refund;
            usdc.safeTransfer(msg.sender, refund);
        }
        emit SubscriptionClaimed(id, msg.sender, shares, refund);
    }

    /// @notice After maturity: principal + accrued − any impairment, pro rata. No early exit (PRD §8.4).
    function redeemFloor(uint256 id, uint256 shares) external nonReentrant {
        Series storage s = _series[id];
        if (s.state != SeriesState.Matured) revert NotMatured();
        uint256 assets = (shares * s.value) / s.principal;
        s.token.burn(msg.sender, shares);
        escrowed -= assets;
        usdc.safeTransfer(msg.sender, assets);
        emit FloorRedeemed(id, msg.sender, shares, assets);
    }

    function series(uint256 id) external view returns (Series memory) {
        return _series[id];
    }

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    /// @notice F: value of the active Floor series.
    function floorValue() public view returns (uint256) {
        return activeSeries == 0 ? 0 : _series[activeSeries - 1].value;
    }

    // ================================================================ Skin

    function postSkin(uint32 blokeId, uint256 amount) external nonReentrant {
        if (msg.sender != registry.claimedWallet(blokeId)) revert NotClaimedWallet();
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 before = skin[blokeId];
        skin[blokeId] = before + amount;
        uint256 min = config.get(Keys.MIN_SKIN_USDC);
        if (before < min && before + amount >= min) skinSince[blokeId] = uint64(block.timestamp);
        emit SkinPosted(blokeId, amount, before + amount);
    }

    /// @notice Executes at the next crank, after that epoch's absorption, and only for the part not
    /// locked by open exposure on the person's markets (amendment A7).
    function requestSkinWithdraw(uint32 blokeId, uint256 amount) external {
        if (msg.sender != registry.claimedWallet(blokeId)) revert NotClaimedWallet();
        if (amount > skin[blokeId]) revert InsufficientSkin();
        skinWithdrawRequest[blokeId] = amount;
        emit SkinWithdrawRequested(blokeId, amount);
    }

    // ================================================================ crank

    struct Totals {
        int256 realized;
        uint256 fees;
        int256 unrealized;
    }

    /// @notice Permissionless; the keeper calls it a few seconds after each epoch ends (PRD §8.3).
    function crankEpoch() external nonReentrant {
        uint256 epochSec = config.get(Keys.EPOCH_SEC);
        if (epochStart != 0 && block.timestamp < epochStart + epochSec) revert EpochNotOver();
        uint256 dt = epochStart == 0 ? 0 : block.timestamp - epochStart;
        if (dt > MAX_EPOCH_DT) dt = MAX_EPOCH_DT;

        uint32 n = _blokeCount();
        _pokeAll(n);
        (Totals memory t, uint256 skinAbsorbed) = _measureAndAbsorb(n);

        // G = Δfees − Δrealised trader gross − Δtrader unrealised + Skin absorbed (6 dp)
        int256 g = int256(t.fees - lastFees) - (t.realized - lastRealized) / int256(WAD_TO_USDC)
            - (t.unrealized - lastUnrealized) / int256(WAD_TO_USDC) + int256(skinAbsorbed);
        lastFees = t.fees;
        lastRealized = t.realized;
        lastUnrealized = t.unrealized;

        (uint256 fee, uint256 dR, uint256 dT, uint256 accrual, int256 dE, uint256 impairment) = _waterfall(g, dt);
        _stopConditions(impairment);
        _processBuckets();
        _rollSeries();
        _skinWithdrawals(n);

        emit EpochSettled(epoch, g, fee, dR, dT, accrual, dE, skinAbsorbed, impairment);
        epoch += 1;
        epochStart = uint64(block.timestamp);
    }

    function _blokeCount() internal view returns (uint32) {
        (bool ok, bytes memory ret) = address(registry).staticcall(abi.encodeWithSignature("blokeCount()"));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint32)) : 0;
    }

    function _pokeAll(uint32 n) internal {
        uint256 total = uint256(n) * 3;
        for (uint256 off; off < total; off += 99) {
            uint256 len = total - off > 99 ? 99 : total - off;
            uint32[] memory ids = new uint32[](len);
            for (uint256 i; i < len; ++i) ids[i] = uint32(3 + off + i); // market ids start at blokeId 1 × 3
            engine.poke(ids);
        }
    }

    /// @dev Sums every market and absorbs this epoch's realised pool losses on each person's markets into
    /// their Skin. Skin covers realised losses only, so marks that later reverse never drain it.
    function _measureAndAbsorb(uint32 n) internal returns (Totals memory t, uint256 absorbed) {
        uint256 minSkin = config.get(Keys.MIN_SKIN_USDC);
        for (uint32 b = 1; b <= n; ++b) {
            int256 realizedB;
            for (uint8 leg; leg < 3; ++leg) {
                (int256 r, uint256 f, int256 u) = engine.poolView(b * 3 + leg);
                t.realized += r;
                t.fees += f;
                t.unrealized += u;
                realizedB += r;
            }
            int256 dB = realizedB - lastRealizedByBloke[b];
            lastRealizedByBloke[b] = realizedB;
            uint256 s = skin[b];
            if (dB > 0 && s > 0) {
                // traders realised gains on this person's markets → the pool lost dB
                uint256 loss = uint256(dB) / WAD_TO_USDC;
                uint256 take = loss > s ? s : loss;
                skin[b] = s - take;
                absorbed += take;
                if (s >= minSkin && s - take < minSkin) skinSince[b] = 0;
                emit SkinAbsorbed(b, take);
            }
        }
    }

    function _waterfall(int256 g, uint256 dt)
        internal
        returns (uint256 fee, uint256 dR, uint256 dT, uint256 accrual, int256 dE, uint256 impairment)
    {
        uint256 F = floorValue();
        uint256 rate = activeSeries == 0 ? 0 : _series[activeSeries - 1].rateBps;
        accrual = (F * rate * dt) / (10_000 * YEAR);

        int256 toEdge;
        if (g > 0) {
            uint256 gu = uint256(g);
            fee = (gu * config.get(Keys.PROTOCOL_FEE_BPS)) / 10_000;
            uint256 target = ((F + edgeNav) * config.get(Keys.RESERVE_TARGET_BPS)) / 10_000;
            uint256 room = target > reserve ? target - reserve : 0;
            uint256 share = (fee * config.get(Keys.RESERVE_SHARE_BPS)) / 10_000;
            dR = share < room ? share : room;
            dT = fee - dR;
            reserve += dR;
            treasury += dT;
            // When 0 < G < fee + A, Edge funds the gap: intended (PRD §8.3).
            toEdge = int256(gu - fee) - int256(accrual);
        } else {
            toEdge = g - int256(accrual);
        }
        (dE, impairment) = _toEdge(toEdge, F + accrual);
        if (activeSeries != 0) {
            Series storage s = _series[activeSeries - 1];
            s.value = s.value + accrual - impairment;
            s.impaired += impairment;
        }
    }

    /// @dev Positive amounts grow E. A shortfall takes E, then the Reserve, then Floor principal.
    function _toEdge(int256 amount, uint256 floorCap) internal returns (int256 dE, uint256 impairment) {
        if (amount >= 0) {
            edgeNav += uint256(amount);
            return (amount, 0);
        }
        uint256 short = uint256(-amount);
        uint256 fromE = short > edgeNav ? edgeNav : short;
        edgeNav -= fromE;
        short -= fromE;
        uint256 fromR = short > reserve ? reserve : short;
        reserve -= fromR;
        short -= fromR;
        impairment = short > floorCap ? floorCap : short;
        dE = -int256(fromE);
    }

    function _stopConditions(uint256 impairment) internal {
        uint256 F = floorValue();
        bool paused = F + edgeNav > 0 && edgeNav * 10_000 < (F + edgeNav) * config.get(Keys.SUBORDINATION_BPS);
        if (paused != floorPaused) {
            floorPaused = paused;
            emit StopCondition("FLOOR_PAUSED", paused);
        }
        bool thin = edgeNav < config.get(Keys.MIN_EDGE_USDC) && epoch > 0;
        if (impairment > 0 && !creditEvent) {
            creditEvent = true;
            emit CreditEvent(impairment);
        }
        if (thin || creditEvent) {
            try engine.enableGlobalReduceOnly() {
                emit StopCondition("REDUCE_ONLY", true);
            } catch {}
        }
    }

    function _processBuckets() internal {
        Bucket storage b = buckets[epoch];
        uint256 supply = edgeShares.totalSupply();
        // Redemptions first, bounded by the subordination floor: E' ≥ 25% of F keeps E'/(F+E') ≥ 20%.
        if (b.redeemShares > 0) {
            uint256 want = (b.redeemShares * (edgeNav + 1)) / (supply + VIRTUAL_SHARES);
            uint256 F = floorValue();
            uint256 sub = config.get(Keys.SUBORDINATION_BPS);
            uint256 minE = (F * sub) / (10_000 - sub);
            uint256 maxOut = edgeNav > minE ? edgeNav - minE : 0;
            uint256 out = want > maxOut ? maxOut : want;
            uint256 filled = want == 0 ? 0 : (b.redeemShares * out) / want;
            b.assetsOut = out;
            b.filledShares = filled;
            edgeNav -= out;
            escrowed += out;
            if (filled > 0) edgeShares.burn(address(this), filled);
            supply -= filled;
        }
        if (b.depositAssets > 0) {
            uint256 shares = (b.depositAssets * (supply + VIRTUAL_SHARES)) / (edgeNav + 1);
            b.sharesOut = shares;
            edgeNav += b.depositAssets;
            escrowed -= b.depositAssets;
            edgeShares.mint(address(this), shares);
        }
        b.processed = true;
    }

    function _rollSeries() internal {
        if (activeSeries != 0) {
            Series storage a = _series[activeSeries - 1];
            if (block.timestamp >= a.end) {
                a.state = SeriesState.Matured;
                escrowed += a.value; // reserved for redemptions
                emit SeriesMatured(activeSeries - 1, a.value);
                activeSeries = 0;
            }
        }
        if (openSeries != 0 && activeSeries == 0) {
            Series storage o = _series[openSeries - 1];
            if (block.timestamp >= o.start) {
                // Fill up to 4 × E (keeps Edge ≥ 20% of the stack); the rest is refundable.
                uint256 cap = edgeNav * 4;
                uint256 filled = o.subscribed > cap ? cap : o.subscribed;
                o.principal = filled;
                o.value = filled;
                o.state = SeriesState.Active;
                escrowed -= filled;
                activeSeries = openSeries;
                openSeries = 0;
                emit SeriesStarted(activeSeries - 1, filled, o.subscribed);
            }
        }
    }

    function _skinWithdrawals(uint32 n) internal {
        uint256 minSkin = config.get(Keys.MIN_SKIN_USDC);
        for (uint32 b = 1; b <= n; ++b) {
            uint256 req = skinWithdrawRequest[b];
            if (req == 0) continue;
            skinWithdrawRequest[b] = 0;
            int256 owed;
            for (uint8 leg; leg < 3; ++leg) {
                (,, int256 u) = engine.poolView(b * 3 + leg);
                owed += u;
            }
            uint256 lock = owed > 0 ? uint256(owed) / WAD_TO_USDC : 0;
            uint256 s = skin[b];
            uint256 free = s > lock ? s - lock : 0;
            uint256 pay = req > free ? free : req;
            if (pay == 0) continue;
            skin[b] = s - pay;
            if (s >= minSkin && s - pay < minSkin) skinSince[b] = 0;
            address to = registry.claimedWallet(b);
            usdc.safeTransfer(to, pay);
            emit SkinWithdrawn(b, to, pay, lock);
        }
    }

    // ================================================================ treasury

    function sweepTreasury() external nonReentrant {
        uint256 t = treasury;
        if (t == 0) revert NothingToClaim();
        treasury = 0;
        address to = config.getAddress(Keys.TREASURY);
        usdc.safeTransfer(to, t);
        emit TreasurySwept(to, t);
    }

    /// @notice Everything the Pool page shows, in one read.
    function nav()
        external
        view
        returns (uint256 F, uint256 E, uint256 R, uint256 T, uint256 subordinationBps, bool paused, bool credit, uint256 currentEpoch, uint64 epochEndsAt)
    {
        F = floorValue();
        E = edgeNav;
        R = reserve;
        T = treasury;
        subordinationBps = F + E == 0 ? 10_000 : (E * 10_000) / (F + E);
        paused = floorPaused;
        credit = creditEvent;
        currentEpoch = epoch;
        epochEndsAt = epochStart == 0 ? uint64(block.timestamp) : epochStart + uint64(config.get(Keys.EPOCH_SEC));
    }
}
