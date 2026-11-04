// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBlokeRegistry, IRegistryHooks} from "../interfaces/IBlokeRegistry.sol";
import {IHumanIndexOracle} from "../interfaces/IHumanIndexOracle.sol";
import {IProtocolConfig} from "../interfaces/IProtocolConfig.sol";
import {Keys} from "../config/Keys.sol";

/// @title BlokeRegistry
/// @notice Listings, claims, verified sources, linked wallets, abuse flags, delisting, rotation and
/// creator fee balances (PRD §9, §12.3). Role gating (LISTER, GUARDIAN, ADMIN, ENGINE) lives in the
/// AccessManager; attestations come from the ATTESTER address in ProtocolConfig.
contract BlokeRegistry is IBlokeRegistry, AccessManaged, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(uint32 blokeId,address wallet,uint256 nonce,uint64 expiry)");
    bytes32 public constant SOURCES_TYPEHASH = keccak256(
        "Sources(uint32 blokeId,uint8 bitmap,bytes32 linkedHash,uint256 nonce,uint64 expiry)"
    );
    bytes32 public constant ROTATION_TYPEHASH = keccak256(
        "Rotation(uint32 blokeId,address oldWallet,address newWallet,uint256 nonce,uint64 expiry)"
    );
    uint256 public constant MAX_ATTESTATION_TTL = 10 minutes;
    uint256 public constant MAX_LINKED = 5;
    uint256 public constant DELIST_TWAP_SEC = 60 minutes;

    struct Bloke {
        bytes16 ticker;
        bytes32 sourceIdsHash;
        uint8 tier;
        Status status;
        uint8 sourceBitmap;
        uint16 abuseFlag; // 0 = none
        bool claimFrozen;
        address wallet;
        uint64 listedAt;
        uint64 liveAt;
        uint64 claimedAt;
        address pendingWallet;
        uint64 rotationReadyAt;
        uint32[3] settlePrice; // b, h, w TWAPs snapshotted at delist request
    }

    IProtocolConfig public immutable config;
    IHumanIndexOracle public immutable oracle;
    IERC20 public immutable usdc;
    IRegistryHooks public engine;

    uint32 public blokeCount;
    mapping(uint32 => Bloke) private _blokes;
    mapping(bytes16 => uint32) public idByTicker;
    mapping(uint32 => address[]) private _linked;
    mapping(uint32 => mapping(address => bool)) private _isLinked;
    mapping(uint256 => bool) public nonceUsed;
    mapping(uint32 => uint256) public creatorBalance;

    event Listed(uint32 indexed blokeId, bytes16 ticker, string name, uint8 tier, bytes32 sourceIdsHash);
    event WentLive(uint32 indexed blokeId);
    event Claimed(uint32 indexed blokeId, address indexed wallet, uint256 escrowMoved);
    event SourcesVerified(uint32 indexed blokeId, uint8 bitmap, address[] linked);
    event RotationRequested(uint32 indexed blokeId, address indexed newWallet, uint64 readyAt);
    event RotationCancelled(uint32 indexed blokeId);
    event RotationFinalized(uint32 indexed blokeId, address indexed newWallet);
    event Flagged(uint32 indexed blokeId, uint16 code);
    event FlagCleared(uint32 indexed blokeId);
    event ClaimFrozen(uint32 indexed blokeId, bool frozen);
    event DelistRequested(uint32 indexed blokeId, address by, uint32 b, uint32 h, uint32 w);
    event DelistRejected(uint32 indexed blokeId);
    event Delisted(uint32 indexed blokeId);
    event Graduated(uint32 indexed blokeId);
    event CreatorFeeCredited(uint32 indexed blokeId, uint256 amount);
    event CreatorFeesWithdrawn(uint32 indexed blokeId, address indexed to, uint256 amount);
    event EngineSet(address engine);

    error InvalidTicker();
    error TickerTaken();
    error InvalidTier();
    error UnknownBloke();
    error NotShadow();
    error ShadowNotOver();
    error AlreadyClaimed();
    error NotClaimed();
    error NotClaimedWallet();
    error ClaimIsFrozen();
    error Timelocked();
    error BadAttestation();
    error Expired();
    error NonceUsed();
    error TooManyLinked();
    error BadStatus();
    error EngineAlreadySet();
    error NoRotation();

    constructor(address authority, IProtocolConfig config_, IHumanIndexOracle oracle_, IERC20 usdc_)
        AccessManaged(authority)
        EIP712("BLOKE Registry", "1")
    {
        config = config_;
        oracle = oracle_;
        usdc = usdc_;
    }

    // ---------------------------------------------------------------- views

    function bloke(uint32 blokeId) external view returns (Bloke memory) {
        return _blokes[blokeId];
    }

    function status(uint32 blokeId) external view returns (Status) {
        return _blokes[blokeId].status;
    }

    function claimedWallet(uint32 blokeId) external view returns (address) {
        return _blokes[blokeId].wallet;
    }

    function tier(uint32 blokeId) external view returns (uint8) {
        return _blokes[blokeId].tier;
    }

    function settlePrice(uint32 blokeId) external view returns (uint32 b, uint32 h, uint32 w) {
        uint32[3] memory sp = _blokes[blokeId].settlePrice;
        return (sp[0], sp[1], sp[2]);
    }

    function linkedWallets(uint32 blokeId) external view returns (address[] memory) {
        return _linked[blokeId];
    }

    /// @notice The claimed wallet or any verified deployer address. The engine refuses trades from
    /// these on the Bloke's own markets (amendment A7).
    function isLinked(uint32 blokeId, address wallet) external view returns (bool) {
        Bloke storage bk = _blokes[blokeId];
        return wallet != address(0) && (wallet == bk.wallet || wallet == bk.pendingWallet || _isLinked[blokeId][wallet]);
    }

    // ---------------------------------------------------------------- listing (LISTER)

    function list(BlokeInit calldata init) external restricted returns (uint32 blokeId) {
        if (!_validTicker(init.ticker)) revert InvalidTicker();
        if (idByTicker[init.ticker] != 0) revert TickerTaken();
        if (init.tier == 0 || init.tier > 3) revert InvalidTier();

        blokeId = ++blokeCount;
        idByTicker[init.ticker] = blokeId;
        Bloke storage bk = _blokes[blokeId];
        bk.ticker = init.ticker;
        bk.sourceIdsHash = init.sourceIdsHash;
        bk.tier = init.tier;
        bk.status = Status.Shadow;
        bk.listedAt = uint64(block.timestamp);

        oracle.setTracked(blokeId, true);
        if (address(engine) != address(0)) engine.onListed(blokeId, init.tier);
        emit Listed(blokeId, init.ticker, init.name, init.tier, init.sourceIdsHash);
    }

    /// @notice Shadow → Live once the shadow period has passed and the oracle holds a full day of
    /// hourly checkpoints, so the 24h band always has a reference (amendment A10).
    function goLive(uint32 blokeId) external restricted {
        Bloke storage bk = _blokes[blokeId];
        if (bk.status != Status.Shadow) revert NotShadow();
        if (
            block.timestamp < bk.listedAt + config.get(Keys.SHADOW_SEC)
                || !oracle.hasHistory(blokeId, config.get(Keys.MIN_HISTORY_HOURS))
        ) {
            revert ShadowNotOver();
        }
        bk.status = Status.Live;
        bk.liveAt = uint64(block.timestamp);
        _hook(blokeId, Status.Live);
        emit WentLive(blokeId);
    }

    // ---------------------------------------------------------------- claims

    function claim(uint32 blokeId, uint256 nonce, uint64 expiry, bytes calldata sig) external {
        Bloke storage bk = _blokes[blokeId];
        if (bk.status == Status.None) revert UnknownBloke();
        if (bk.wallet != address(0)) revert AlreadyClaimed();
        _verify(keccak256(abi.encode(CLAIM_TYPEHASH, blokeId, msg.sender, nonce, expiry)), nonce, expiry, sig);
        bk.wallet = msg.sender;
        bk.claimedAt = uint64(block.timestamp);
        emit Claimed(blokeId, msg.sender, creatorBalance[blokeId]);
    }

    /// @notice Writes the verified-source bitmap and the deployer addresses (≤ 5) that proved control.
    function setSourceVerification(
        uint32 blokeId,
        uint8 bitmap,
        address[] calldata linked,
        uint256 nonce,
        uint64 expiry,
        bytes calldata sig
    ) external {
        Bloke storage bk = _onlyClaimedWallet(blokeId);
        if (linked.length > MAX_LINKED) revert TooManyLinked();
        bytes32 linkedHash = keccak256(abi.encodePacked(linked));
        _verify(keccak256(abi.encode(SOURCES_TYPEHASH, blokeId, bitmap, linkedHash, nonce, expiry)), nonce, expiry, sig);

        address[] storage old = _linked[blokeId];
        for (uint256 i; i < old.length; ++i) {
            _isLinked[blokeId][old[i]] = false;
        }
        delete _linked[blokeId];
        for (uint256 i; i < linked.length; ++i) {
            _isLinked[blokeId][linked[i]] = true;
            _linked[blokeId].push(linked[i]);
        }
        bk.sourceBitmap = bitmap;
        emit SourcesVerified(blokeId, bitmap, linked);
    }

    function requestRotation(address newWallet, uint32 blokeId, uint256 nonce, uint64 expiry, bytes calldata sig)
        external
    {
        Bloke storage bk = _onlyClaimedWallet(blokeId);
        if (bk.claimFrozen) revert ClaimIsFrozen();
        _verify(
            keccak256(abi.encode(ROTATION_TYPEHASH, blokeId, msg.sender, newWallet, nonce, expiry)), nonce, expiry, sig
        );
        bk.pendingWallet = newWallet;
        bk.rotationReadyAt = uint64(block.timestamp + config.get(Keys.ROTATION_TIMELOCK_SEC));
        emit RotationRequested(blokeId, newWallet, bk.rotationReadyAt);
    }

    function cancelRotation(uint32 blokeId) external {
        Bloke storage bk = _onlyClaimedWallet(blokeId);
        if (bk.pendingWallet == address(0)) revert NoRotation();
        bk.pendingWallet = address(0);
        bk.rotationReadyAt = 0;
        emit RotationCancelled(blokeId);
    }

    function finalizeRotation(uint32 blokeId) external {
        Bloke storage bk = _blokes[blokeId];
        if (bk.pendingWallet == address(0)) revert NoRotation();
        if (bk.claimFrozen) revert ClaimIsFrozen();
        if (block.timestamp < bk.rotationReadyAt) revert Timelocked();
        bk.wallet = bk.pendingWallet;
        bk.pendingWallet = address(0);
        bk.rotationReadyAt = 0;
        emit RotationFinalized(blokeId, bk.wallet);
    }

    // ---------------------------------------------------------------- creator fees

    /// @notice ENGINE role: the engine has already transferred `amount` tUSDC to this contract.
    function creditCreator(uint32 blokeId, uint256 amount) external restricted {
        creatorBalance[blokeId] += amount;
        emit CreatorFeeCredited(blokeId, amount);
    }

    function withdrawCreatorFees(uint32 blokeId) external nonReentrant {
        Bloke storage bk = _onlyClaimedWallet(blokeId);
        if (bk.claimFrozen) revert ClaimIsFrozen();
        if (block.timestamp < bk.claimedAt + config.get(Keys.CLAIM_WITHDRAW_DELAY_SEC)) revert Timelocked();
        uint256 amount = creatorBalance[blokeId];
        creatorBalance[blokeId] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit CreatorFeesWithdrawn(blokeId, msg.sender, amount);
    }

    /// @notice LAUNCHER role: hands the creator balance to the graduation launcher for pool seeding.
    function takeCreatorBalanceForGraduation(uint32 blokeId) external restricted nonReentrant returns (uint256 amount) {
        Bloke storage bk = _blokes[blokeId];
        if (bk.status != Status.Live || bk.claimFrozen) revert BadStatus();
        amount = creatorBalance[blokeId];
        creatorBalance[blokeId] = 0;
        bk.status = Status.Graduated;
        usdc.safeTransfer(msg.sender, amount);
        emit Graduated(blokeId);
    }

    // ---------------------------------------------------------------- guardian / admin

    function flag(uint32 blokeId, uint16 code) external restricted {
        if (_blokes[blokeId].status == Status.None) revert UnknownBloke();
        _blokes[blokeId].abuseFlag = code == 0 ? 1 : code;
        emit Flagged(blokeId, code);
    }

    function clearFlag(uint32 blokeId) external restricted {
        _blokes[blokeId].abuseFlag = 0;
        emit FlagCleared(blokeId);
    }

    function freezeClaim(uint32 blokeId) external restricted {
        _blokes[blokeId].claimFrozen = true;
        emit ClaimFrozen(blokeId, true);
    }

    function unfreezeClaim(uint32 blokeId) external restricted {
        _blokes[blokeId].claimFrozen = false;
        emit ClaimFrozen(blokeId, false);
    }

    /// @notice Claimed wallet or LISTER. Snapshots the 60-minute TWAP now and moves the markets to
    /// ReduceOnly, so the settlement price can't be moved during the 48h review (amendment A10).
    function requestDelist(uint32 blokeId) external {
        Bloke storage bk = _blokes[blokeId];
        if (bk.status != Status.Live && bk.status != Status.Shadow && bk.status != Status.Graduated) {
            revert BadStatus();
        }
        if (msg.sender != bk.wallet) {
            (bool allowed,) = IAuthorityLike(authority()).canCall(msg.sender, address(this), this.requestDelist.selector);
            if (!allowed) revert NotClaimedWallet();
        }
        bk.settlePrice = [
            oracle.twap(blokeId, IHumanIndexOracle.Leg.Blend, DELIST_TWAP_SEC),
            oracle.twap(blokeId, IHumanIndexOracle.Leg.Hype, DELIST_TWAP_SEC),
            oracle.twap(blokeId, IHumanIndexOracle.Leg.Work, DELIST_TWAP_SEC)
        ];
        bk.status = Status.DelistPending;
        _hook(blokeId, Status.DelistPending);
        emit DelistRequested(blokeId, msg.sender, bk.settlePrice[0], bk.settlePrice[1], bk.settlePrice[2]);
    }

    function approveDelist(uint32 blokeId) external restricted {
        Bloke storage bk = _blokes[blokeId];
        if (bk.status != Status.DelistPending) revert BadStatus();
        bk.status = Status.Delisted;
        oracle.setTracked(blokeId, false);
        _hook(blokeId, Status.Delisted);
        emit Delisted(blokeId);
    }

    function rejectDelist(uint32 blokeId) external restricted {
        Bloke storage bk = _blokes[blokeId];
        if (bk.status != Status.DelistPending) revert BadStatus();
        bk.status = bk.liveAt != 0 ? Status.Live : Status.Shadow;
        delete bk.settlePrice;
        _hook(blokeId, bk.status);
        emit DelistRejected(blokeId);
    }

    function setEngine(IRegistryHooks engine_) external restricted {
        if (address(engine) != address(0)) revert EngineAlreadySet();
        engine = engine_;
        emit EngineSet(address(engine_));
    }

    // ---------------------------------------------------------------- internals

    function _onlyClaimedWallet(uint32 blokeId) private view returns (Bloke storage bk) {
        bk = _blokes[blokeId];
        if (bk.wallet == address(0)) revert NotClaimed();
        if (msg.sender != bk.wallet) revert NotClaimedWallet();
    }

    function _verify(bytes32 structHash, uint256 nonce, uint64 expiry, bytes calldata sig) private {
        if (expiry < block.timestamp || expiry > block.timestamp + MAX_ATTESTATION_TTL) revert Expired();
        if (nonceUsed[nonce]) revert NonceUsed();
        if (ECDSA.recover(_hashTypedDataV4(structHash), sig) != config.getAddress(Keys.ATTESTER)) {
            revert BadAttestation();
        }
        nonceUsed[nonce] = true;
    }

    function _hook(uint32 blokeId, Status s) private {
        if (address(engine) != address(0)) engine.onBlokeStatus(blokeId, s);
    }

    /// @dev `[A-Z0-9]{2,10}`, left-aligned in bytes16 and zero-padded.
    function _validTicker(bytes16 t) private pure returns (bool) {
        uint256 len;
        for (uint256 i; i < 16; ++i) {
            bytes1 c = t[i];
            if (c == 0) break;
            if (!((c >= "A" && c <= "Z") || (c >= "0" && c <= "9"))) return false;
            ++len;
        }
        for (uint256 i = len; i < 16; ++i) {
            if (t[i] != 0) return false;
        }
        return len >= 2 && len <= 10;
    }
}

interface IAuthorityLike {
    function canCall(address caller, address target, bytes4 selector) external view returns (bool, uint32);
}
