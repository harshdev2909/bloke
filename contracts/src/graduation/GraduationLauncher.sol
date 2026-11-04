// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IProtocolConfig} from "../interfaces/IProtocolConfig.sol";
import {IHumanIndexOracle} from "../interfaces/IHumanIndexOracle.sol";
import {IBlokeRegistry} from "../interfaces/IBlokeRegistry.sol";
import {Keys} from "../config/Keys.sol";
import {BlokeRegistry} from "../registry/BlokeRegistry.sol";
import {MarketEngine} from "../engine/MarketEngine.sol";
import {BlokePool} from "../pool/BlokePool.sol";
import {BlokeV2Factory} from "../amm/BlokeV2Factory.sol";
import {BlokeV2Pair} from "../amm/BlokeV2Pair.sol";
import {BlokeToken} from "./BlokeToken.sol";
import {BlokeDesk} from "./BlokeDesk.sol";
import {LPLocker} from "./LPLocker.sol";
import {VestingStream} from "./VestingStream.sol";
import {MerkleDistributor} from "./MerkleDistributor.sol";

/// @notice Graduation (PRD §10): eight checks, then one transaction by the claimed wallet deploys the
/// Bloke's token, seeds and locks a $NAME/tBLOKE pool, and starts the airdrop, backer claims and the
/// person's vesting. Every step is atomic.
///
/// Check 5 (time-weighted gross OI) needs the engine's OI·time accumulator at the start of the window,
/// so `snapshotOi` (permissionless, called daily by the keeper) keeps a ring of daily readings.
contract GraduationLauncher is AccessManaged, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant SUPPLY = 1_000_000_000 ether;
    uint256 public constant LIQUIDITY = 500_000_000 ether;
    uint256 public constant AIRDROP = 200_000_000 ether;
    uint256 public constant VESTING = 150_000_000 ether;
    uint256 public constant BACKERS = 100_000_000 ether;
    uint256 public constant TREASURY_SHARE = 50_000_000 ether;
    uint64 public constant LP_LOCK = 365 days;
    uint64 public constant CLAIM_WINDOW = 90 days;
    uint64 public constant CLIFF = 90 days;
    uint64 public constant VEST_DURATION = 365 days;
    uint256 public constant MAX_ATTESTATION_TTL = 10 minutes;
    uint256 private constant SNAP_SLOTS = 32;
    uint256 private constant SNAP_MIN_GAP = 12 hours;

    bytes32 public constant GRAD_TYPEHASH = keccak256(
        "GradAttestation(uint32 blokeId,uint32 traderCount,bytes32 airdropRoot,uint256 airdropTotal,bytes32 backerRoot,uint256 backerTotal,uint256 nonce,uint64 expiry)"
    );

    struct GradAttestation {
        uint32 blokeId;
        uint32 traderCount;
        bytes32 airdropRoot;
        uint256 airdropTotal;
        bytes32 backerRoot;
        uint256 backerTotal;
        uint256 nonce;
        uint64 expiry;
    }

    struct Graduation {
        address token;
        address pair;
        uint64 at;
        uint32 lockId;
        uint32 streamId;
        uint32 airdropId;
        uint32 backerId;
        uint256 seedUsdc;
        uint256 seedTbloke;
    }

    struct OiSnap {
        uint64 ts;
        uint192 acc;
    }

    IProtocolConfig public immutable config;
    IHumanIndexOracle public immutable oracle;
    BlokeRegistry public immutable registry;
    MarketEngine public immutable engine;
    BlokePool public immutable pool;
    IERC20 public immutable usdc;
    IERC20 public immutable tbloke;
    BlokeDesk public immutable desk;
    BlokeV2Factory public immutable factory;
    LPLocker public immutable locker;
    VestingStream public immutable vesting;
    MerkleDistributor public immutable distributor;

    mapping(uint32 => Graduation) public graduations;
    mapping(uint256 => bool) public usedNonce;
    mapping(uint32 => OiSnap[SNAP_SLOTS]) private _snaps;
    mapping(uint32 => uint8) private _snapHead;

    error NotClaimedWallet();
    error CheckFailed(uint8 check);
    error BadAttestation();
    error AttestationExpired();
    error NonceUsed();
    error BadTotals();
    error NothingToSeed();
    error PairNotClean();
    error Leftover();

    event Graduated(
        uint32 indexed blokeId,
        address token,
        address pair,
        uint256 lockId,
        uint256 streamId,
        uint256 airdropId,
        uint256 backerId,
        bytes32 airdropRoot,
        bytes32 backerRoot
    );
    event OiSnapshot(uint32 indexed blokeId, uint64 ts, uint256 acc);
    event SnapshotSkipped(uint32 indexed blokeId);

    struct Deps {
        IProtocolConfig config;
        IHumanIndexOracle oracle;
        BlokeRegistry registry;
        MarketEngine engine;
        BlokePool pool;
        IERC20 usdc;
        IERC20 tbloke;
        BlokeDesk desk;
        BlokeV2Factory factory;
        LPLocker locker;
        VestingStream vesting;
        MerkleDistributor distributor;
    }

    constructor(address authority, Deps memory d) AccessManaged(authority) EIP712("BLOKE Graduation", "1") {
        config = d.config;
        oracle = d.oracle;
        registry = d.registry;
        engine = d.engine;
        pool = d.pool;
        usdc = d.usdc;
        tbloke = d.tbloke;
        desk = d.desk;
        factory = d.factory;
        locker = d.locker;
        vesting = d.vesting;
        distributor = d.distributor;
    }

    // ---------------------------------------------------------------- checks (PRD §10.1)

    /// @notice Each check's pass flag, current value and threshold, for the UI checklist. Check 6
    /// (identity-linked traders) is attested off-chain: pass `traderCount` from the attester, or 0.
    function checks(uint32 blokeId, uint32 traderCount)
        public
        view
        returns (bool[8] memory pass, uint256[8] memory value, uint256[8] memory threshold)
    {
        BlokeRegistry.Bloke memory bk = registry.bloke(blokeId);
        // 1. claimed, not frozen, and Live (graduation takes the creator balance from a Live Bloke)
        value[0] = uint256(bk.status);
        threshold[0] = uint256(IBlokeRegistry.Status.Live);
        pass[0] = bk.wallet != address(0) && !bk.claimFrozen && bk.status == IBlokeRegistry.Status.Live;
        // 2. at least one verified output source
        value[1] = bk.sourceBitmap;
        threshold[1] = 1;
        pass[1] = bk.sourceBitmap != 0;
        // 3–4. Human Capital Score and work over hype, both on the window average
        uint256 days_ = config.get(Keys.GRAD_AVG_DAYS);
        (uint32 b, uint32 h, uint32 w, uint256 nDays) = oracle.avg(blokeId, days_);
        value[2] = b;
        threshold[2] = config.get(Keys.GRAD_MIN_HCS);
        pass[2] = nDays >= days_ && b >= threshold[2];
        value[3] = w;
        threshold[3] = h;
        pass[3] = nDays >= days_ && w >= h && w > 0;
        // 5. time-weighted gross OI over the window
        threshold[4] = config.get(Keys.GRAD_MIN_OI_USDC);
        bool known;
        (value[4], known) = avgOi(blokeId, config.get(Keys.GRAD_OI_DAYS) * 1 days);
        pass[4] = threshold[4] == 0 || (known && value[4] >= threshold[4]);
        // 6. identity-linked traders (attested)
        value[5] = traderCount;
        threshold[5] = config.get(Keys.GRAD_MIN_TRADERS);
        pass[5] = traderCount >= threshold[5];
        // 7. Skin held continuously
        uint256 since = pool.skinSince(blokeId);
        value[6] = since == 0 ? 0 : block.timestamp - since;
        threshold[6] = config.get(Keys.GRAD_SKIN_DAYS) * 1 days;
        pass[6] = since != 0 && pool.skin(blokeId) >= config.get(Keys.MIN_SKIN_USDC) && value[6] >= threshold[6];
        // 8. no open abuse flag, never graduated
        value[7] = bk.abuseFlag;
        pass[7] = bk.abuseFlag == 0 && bk.status != IBlokeRegistry.Status.Graduated && graduations[blokeId].token == address(0);
    }

    // ---------------------------------------------------------------- OI snapshots (check 5)

    /// @notice Σ over the Bloke's three markets of the OI·time accumulator, accrued to now.
    function oiAccNow(uint32 blokeId) public view returns (uint256 acc) {
        for (uint8 leg; leg < 3; ++leg) {
            MarketEngine.Market memory m = engine.market(blokeId * 3 + leg);
            acc += uint256(m.oiTimeAcc) + uint256(m.grossCollateral) * (block.timestamp - m.ts);
        }
    }

    /// @notice Permissionless; at most one reading per Bloke every 12 hours. Capped at 100 ids.
    function snapshotOi(uint32[] calldata blokeIds) external {
        uint256 n = blokeIds.length > 100 ? 100 : blokeIds.length;
        for (uint256 i; i < n; ++i) {
            uint32 id = blokeIds[i];
            uint8 head = _snapHead[id];
            OiSnap memory last = _snaps[id][head];
            if ((last.ts != 0 && block.timestamp - last.ts < SNAP_MIN_GAP) || registry.status(id) == IBlokeRegistry.Status.None) {
                emit SnapshotSkipped(id);
                continue;
            }
            uint256 acc = oiAccNow(id);
            uint8 next = last.ts == 0 ? head : uint8((uint256(head) + 1) % SNAP_SLOTS);
            _snaps[id][next] = OiSnap(uint64(block.timestamp), uint192(acc));
            _snapHead[id] = next;
            emit OiSnapshot(id, uint64(block.timestamp), acc);
        }
    }

    /// @notice Mean gross OI (6 dp) since the newest snapshot at least `window` old; `known` is false
    /// when no snapshot is old enough yet.
    function avgOi(uint32 blokeId, uint256 window) public view returns (uint256 avg, bool known) {
        uint8 head = _snapHead[blokeId];
        for (uint256 i; i < SNAP_SLOTS; ++i) {
            OiSnap memory s = _snaps[blokeId][(uint256(head) + SNAP_SLOTS - i) % SNAP_SLOTS];
            if (s.ts == 0) break;
            if (block.timestamp - s.ts >= window && block.timestamp > s.ts) {
                return ((oiAccNow(blokeId) - s.acc) / (block.timestamp - s.ts), true);
            }
        }
        return (0, false);
    }

    // ---------------------------------------------------------------- graduate (PRD §10.2)

    function attestationDigest(GradAttestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(GRAD_TYPEHASH, a.blokeId, a.traderCount, a.airdropRoot, a.airdropTotal, a.backerRoot, a.backerTotal, a.nonce, a.expiry)
            )
        );
    }

    function graduate(GradAttestation calldata a, bytes calldata sig) external nonReentrant returns (address token, address pair) {
        uint32 blokeId = a.blokeId;
        address person = registry.claimedWallet(blokeId);
        if (msg.sender != person || person == address(0)) revert NotClaimedWallet();
        _verify(a, sig);
        {
            (bool[8] memory pass,,) = checks(blokeId, a.traderCount);
            for (uint8 i; i < 8; ++i) {
                if (!pass[i]) revert CheckFailed(i + 1);
            }
        }
        if (a.airdropTotal != AIRDROP || a.backerTotal != BACKERS) revert BadTotals();

        address treasury = config.getAddress(Keys.TREASURY);
        // 3. seed value: creator balance (also flips the registry to Graduated) + the graduation fee
        uint256 creator = registry.takeCreatorBalanceForGraduation(blokeId);
        uint256 fee = config.get(Keys.GRAD_FEE_USDC);
        if (fee > 0) usdc.safeTransferFrom(treasury, address(this), fee);
        uint256 seedUsdc = creator + fee;
        if (seedUsdc == 0) revert NothingToSeed();
        usdc.forceApprove(address(desk), seedUsdc);
        uint256 seedT = desk.buy(seedUsdc, desk.quoteBuy(seedUsdc));

        // 2. the token, at a CREATE2 address salted by blokeId
        bytes16 t = registry.bloke(blokeId).ticker;
        string memory symbol = _ticker(t);
        token = address(new BlokeToken{salt: bytes32(uint256(blokeId))}(string.concat("BLOKE: ", symbol), symbol, blokeId));

        // 4–5. a clean pair, seeded and locked
        pair = factory.getPair(token, address(tbloke));
        if (pair == address(0)) {
            pair = factory.createPair(token, address(tbloke));
        } else {
            (uint112 r0, uint112 r1,) = BlokeV2Pair(pair).getReserves();
            if (r0 != 0 || r1 != 0 || IERC20(token).balanceOf(pair) != 0) revert PairNotClean();
        }
        IERC20(token).safeTransfer(pair, LIQUIDITY);
        tbloke.safeTransfer(pair, seedT);
        uint256 lp = BlokeV2Pair(pair).mint(address(locker));

        Graduation storage g = graduations[blokeId];
        g.token = token;
        g.pair = pair;
        g.at = uint64(block.timestamp);
        g.seedUsdc = seedUsdc;
        g.seedTbloke = seedT;
        g.lockId = uint32(locker.lock(IERC20(pair), lp, uint64(block.timestamp) + LP_LOCK, person, uint16((creator * 10_000) / seedUsdc), treasury));

        // 6–8. allocations
        uint64 deadline = uint64(block.timestamp) + CLAIM_WINDOW;
        IERC20(token).safeTransfer(address(distributor), AIRDROP + BACKERS);
        g.airdropId = uint32(distributor.create(IERC20(token), a.airdropRoot, AIRDROP, deadline, treasury));
        g.backerId = uint32(distributor.create(IERC20(token), a.backerRoot, BACKERS, deadline, treasury));
        IERC20(token).safeTransfer(address(vesting), VESTING);
        g.streamId = uint32(vesting.create(IERC20(token), person, VESTING, uint64(block.timestamp), CLIFF, VEST_DURATION));
        IERC20(token).safeTransfer(treasury, TREASURY_SHARE);

        // 9. nothing left behind; transfers on, permanently
        if (IERC20(token).balanceOf(address(this)) != 0) revert Leftover();
        BlokeToken(token).enableTransfers();
        emit Graduated(blokeId, token, pair, g.lockId, g.streamId, g.airdropId, g.backerId, a.airdropRoot, a.backerRoot);
    }

    function _verify(GradAttestation calldata a, bytes calldata sig) private {
        if (block.timestamp > a.expiry || a.expiry > block.timestamp + MAX_ATTESTATION_TTL) revert AttestationExpired();
        if (usedNonce[a.nonce]) revert NonceUsed();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(attestationDigest(a), sig);
        if (err != ECDSA.RecoverError.NoError || signer != config.getAddress(Keys.ATTESTER)) revert BadAttestation();
        usedNonce[a.nonce] = true;
    }

    /// @dev bytes16 ticker, zero-padded on the right, to a string.
    function _ticker(bytes16 t) private pure returns (string memory) {
        uint256 n;
        while (n < 16 && t[n] != 0) ++n;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) out[i] = t[i];
        return string(out);
    }

    /// @notice CREATE2 address a Bloke's token will have (lets anyone check a pair isn't pre-seeded).
    function predictToken(uint32 blokeId) external view returns (address) {
        bytes16 t = registry.bloke(blokeId).ticker;
        string memory symbol = _ticker(t);
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(uint256(blokeId)),
                keccak256(abi.encodePacked(type(BlokeToken).creationCode, abi.encode(string.concat("BLOKE: ", symbol), symbol, blokeId)))
            )
        );
        return address(uint160(uint256(h)));
    }
}
