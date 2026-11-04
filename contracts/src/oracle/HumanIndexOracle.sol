// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IHumanIndexOracle} from "../interfaces/IHumanIndexOracle.sol";
import {IProtocolConfig} from "../interfaces/IProtocolConfig.sol";
import {Keys} from "../config/Keys.sol";

/// @title HumanIndexOracle
/// @notice Accepts signed, batched Human Capital Index pushes and bounds how far any push can move
/// a value (PRD §5). Amendment A1: every clamp that bites sets a per-leg lag flag recording which
/// way the signed raw value sits relative to the applied one, so the engine can refuse fills that
/// would profit from the predictable catch-up of later pushes.
contract HumanIndexOracle is IHumanIndexOracle, AccessManaged, EIP712 {
    uint32 public constant INDEX_MIN = 5_000; // 0.5
    uint32 public constant INDEX_MAX = 2_000_000; // 200.0
    uint256 private constant HOUR_MS = 3_600_000;
    uint256 private constant MINUTE_MS = 60_000;
    uint256 private constant HOURLY_SLOTS = 25; // one more than 24 so "24h ago" survives this hour's write
    uint256 private constant DAILY_SLOTS = 32;
    uint256 private constant MINUTE_SLOTS = 64;
    uint256 private constant BAND_FALLBACK_HOURS = 6;

    bytes32 public constant ENTRY_TYPEHASH = keccak256("IndexEntry(uint32 blokeId,uint32 b,uint32 h,uint32 w)");
    bytes32 public constant PUSH_TYPEHASH = keccak256(
        "IndexPush(uint64 seq,uint64 tsMs,bytes32 paramsVersion,IndexEntry[] entries)IndexEntry(uint32 blokeId,uint32 b,uint32 h,uint32 w)"
    );

    // Clamp reasons for IndexClamped
    uint8 public constant REASON_RANGE = 1;
    uint8 public constant REASON_STEP = 2;
    uint8 public constant REASON_BAND = 3;

    struct Latest {
        uint32 b;
        uint32 h;
        uint32 w;
        uint48 tsMs;
        uint8 lag; // bit 2*leg = raw above applied, bit 2*leg+1 = raw below applied
        bool tracked;
        uint32 firstHour;
        bool seen;
    }

    struct Checkpoint {
        uint32 b;
        uint32 h;
        uint32 w;
        uint32 hour; // UTC hour number + 1, so 0 means empty
    }

    struct Day {
        uint32 day; // UTC day number + 1, so 0 means empty
        uint16 count;
        uint64 sumB;
        uint64 sumH;
        uint64 sumW;
    }

    /// @dev Band reference cached per Bloke for the current UTC hour; the reference only changes hourly.
    struct BandCache {
        uint32 b;
        uint32 h;
        uint32 w;
        uint32 forHour; // hour number + 1
        bool has;
    }

    /// @dev One sample per minute (the first push of the minute), for the minute-resolution TWAP.
    struct Obs {
        uint48 tsMs;
        uint32 b;
        uint32 h;
        uint32 w;
    }

    /// @dev Parameters cached from ProtocolConfig (re-synced on every config change), so a push reads
    /// two packed slots instead of making seven external calls.
    struct Params {
        address signer;
        uint16 step;
        uint16 bandLo;
        uint16 bandHi;
        uint8 maxEntries;
        uint16 freshSec;
    }

    struct Window {
        uint32 pastMs;
        uint32 futureMs;
    }

    IProtocolConfig public immutable config;

    uint64 public lastSeq;
    uint64 public lastTsMs;
    bytes32 public lastParamsVersion;
    bool public paused;
    Params public params;
    Window public window;

    mapping(uint32 => Latest) private _latest;
    mapping(uint32 => Checkpoint[HOURLY_SLOTS]) private _hourly;
    mapping(uint32 => Day[DAILY_SLOTS]) private _daily;
    mapping(uint32 => Obs[MINUTE_SLOTS]) private _minutes;
    mapping(uint32 => BandCache) private _band;

    event IndexPushed(uint64 indexed seq, uint64 tsMs, uint256 count, bytes32 paramsVersion);
    event IndexClamped(uint32 indexed blokeId, Leg leg, uint32 raw, uint32 applied, uint8 reason);
    event EntrySkipped(uint32 indexed blokeId);
    event TrackedSet(uint32 indexed blokeId, bool tracked);
    event OraclePausedSet(bool paused);

    error BadSignature();
    error BadSeq();
    error StalePush();
    error FuturePush();
    error TooManyEntries();
    error OraclePaused();
    error WindowTooLong();

    constructor(address authority, IProtocolConfig config_) AccessManaged(authority) EIP712("BLOKE Oracle", "1") {
        config = config_;
        syncParams();
    }

    /// @notice Copies parameters from ProtocolConfig. Permissionless and idempotent; ProtocolConfig
    /// calls it on every change.
    function syncParams() public {
        params = Params({
            signer: config.getAddress(Keys.ORACLE_SIGNER),
            step: uint16(config.get(Keys.ORACLE_STEP_BPS)),
            bandLo: uint16(config.get(Keys.ORACLE_BAND_LO_BPS)),
            bandHi: uint16(config.get(Keys.ORACLE_BAND_HI_BPS)),
            maxEntries: uint8(config.get(Keys.ORACLE_MAX_ENTRIES)),
            freshSec: uint16(config.get(Keys.ORACLE_FRESH_SEC))
        });
        window = Window(uint32(config.get(Keys.ORACLE_PAST_MS)), uint32(config.get(Keys.ORACLE_FUTURE_MS)));
    }

    // ---------------------------------------------------------------- push

    function push(IndexPush calldata p, bytes calldata sig) external {
        if (paused) revert OraclePaused();
        if (p.seq != lastSeq + 1) revert BadSeq();
        uint256 n = p.entries.length;
        Params memory prm = params;
        if (n > prm.maxEntries) revert TooManyEntries();

        uint256 nowMs = block.timestamp * 1000;
        Window memory win = window;
        if (p.tsMs + win.pastMs < nowMs || p.tsMs <= lastTsMs) revert StalePush();
        if (p.tsMs > nowMs + win.futureMs) revert FuturePush();

        if (ECDSA.recover(_hashTypedDataV4(_hashPush(p)), sig) != prm.signer) revert BadSignature();

        lastSeq = p.seq;
        lastTsMs = p.tsMs;
        if (lastParamsVersion != p.paramsVersion) lastParamsVersion = p.paramsVersion;

        Bounds memory bnd = Bounds({step: prm.step, lo: prm.bandLo, hi: prm.bandHi});
        for (uint256 i; i < n; ++i) {
            _apply(p.entries[i], p.tsMs, bnd);
        }
        emit IndexPushed(p.seq, p.tsMs, n, p.paramsVersion);
    }

    struct Bounds {
        uint256 step;
        uint256 lo;
        uint256 hi;
    }

    function _apply(IndexEntry calldata e, uint64 tsMs, Bounds memory bnd) private {
        Latest memory l = _latest[e.blokeId];
        if (!l.tracked) {
            emit EntrySkipped(e.blokeId);
            return;
        }
        uint32 hour = uint32(tsMs / HOUR_MS);
        bool newMinute = !l.seen || tsMs / MINUTE_MS != uint256(l.tsMs) / MINUTE_MS;

        if (l.seen) {
            uint32 prevHour = uint32(uint256(l.tsMs) / HOUR_MS);
            if (hour > prevHour) _closeHour(e.blokeId, prevHour, l);
        } else {
            l.firstHour = hour;
            l.seen = true;
        }

        BandCache memory ref = _band[e.blokeId];
        if (ref.forHour != hour + 1) {
            Checkpoint memory cp = _bandRef(e.blokeId, hour, l.firstHour);
            ref = BandCache(cp.b, cp.h, cp.w, hour + 1, cp.hour != 0);
            _band[e.blokeId] = ref;
        }
        uint8 lag;
        uint32 b;
        uint32 h;
        uint32 w;
        uint8 legLag;
        (b, legLag) = _clamp(e.blokeId, Leg.Blend, e.b, l.tsMs != 0 ? l.b : 0, ref.has ? ref.b : 0, bnd);
        lag |= legLag;
        (h, legLag) = _clamp(e.blokeId, Leg.Hype, e.h, l.tsMs != 0 ? l.h : 0, ref.has ? ref.h : 0, bnd);
        lag |= legLag << 2;
        (w, legLag) = _clamp(e.blokeId, Leg.Work, e.w, l.tsMs != 0 ? l.w : 0, ref.has ? ref.w : 0, bnd);
        lag |= legLag << 4;

        _latest[e.blokeId] = Latest({
            b: b,
            h: h,
            w: w,
            tsMs: uint48(tsMs),
            lag: lag,
            tracked: true,
            firstHour: l.firstHour,
            seen: true
        });
        if (newMinute) _minutes[e.blokeId][(tsMs / MINUTE_MS) % MINUTE_SLOTS] = Obs(uint48(tsMs), b, h, w);
    }

    /// @dev Range clamp, then the 24h band, then the step clamp from the stored value. The step
    /// clamp wins when step and band disagree, so a value never jumps more than one step per push.
    function _clamp(uint32 blokeId, Leg leg, uint32 raw, uint32 prev, uint32 ref, Bounds memory bnd)
        private
        returns (uint32 applied, uint8 lagBits)
    {
        uint256 v = raw;
        if (v < INDEX_MIN) v = INDEX_MIN;
        if (v > INDEX_MAX) v = INDEX_MAX;
        uint256 target = v;
        uint8 reason = v != raw ? REASON_RANGE : 0;

        if (ref != 0) {
            uint256 lo = (uint256(ref) * bnd.lo) / 10_000;
            uint256 hi = (uint256(ref) * bnd.hi) / 10_000;
            if (target < lo) (target, reason) = (lo, REASON_BAND);
            else if (target > hi) (target, reason) = (hi, REASON_BAND);
        }
        uint256 out = target;
        if (prev != 0) {
            uint256 lo = (uint256(prev) * (10_000 - bnd.step) + 9_999) / 10_000;
            uint256 hi = (uint256(prev) * (10_000 + bnd.step)) / 10_000;
            if (out < lo) (out, reason) = (lo, REASON_STEP);
            else if (out > hi) (out, reason) = (hi, REASON_STEP);
        }
        if (out < INDEX_MIN) out = INDEX_MIN;
        if (out > INDEX_MAX) out = INDEX_MAX;
        applied = uint32(out);

        // Lag is measured against the range-clamped raw value; the absolute range never lags.
        if (v > out) lagBits = 1;
        else if (v < out) lagBits = 2;
        if (applied != raw) emit IndexClamped(blokeId, leg, raw, applied, reason);
    }

    function _closeHour(uint32 blokeId, uint32 prevHour, Latest memory l) private {
        _hourly[blokeId][prevHour % HOURLY_SLOTS] = Checkpoint(l.b, l.h, l.w, prevHour + 1);
        uint32 day = prevHour / 24;
        Day storage d = _daily[blokeId][day % DAILY_SLOTS];
        if (d.day != day + 1) {
            d.day = day + 1;
            d.count = 0;
            d.sumB = 0;
            d.sumH = 0;
            d.sumW = 0;
        }
        d.count += 1;
        d.sumB += l.b;
        d.sumH += l.h;
        d.sumW += l.w;
    }

    /// @dev Reference for the 24h band: the checkpoint from exactly 24h ago; else the nearest newer
    /// one within BAND_FALLBACK_HOURS; else, during a Bloke's first day, its first-hour checkpoint.
    function _bandRef(uint32 blokeId, uint32 hour, uint32 firstHour) private view returns (Checkpoint memory cp) {
        if (hour < 24) return cp;
        uint32 refHour = hour - 24;
        Checkpoint[HOURLY_SLOTS] storage ring = _hourly[blokeId];
        for (uint32 i; i <= BAND_FALLBACK_HOURS; ++i) {
            uint32 hh = refHour + i;
            if (hh >= hour) break;
            cp = ring[hh % HOURLY_SLOTS];
            if (cp.hour == hh + 1) return cp;
        }
        if (firstHour < hour && firstHour + 24 > hour) {
            cp = ring[firstHour % HOURLY_SLOTS];
            if (cp.hour == firstHour + 1) return cp;
        }
        delete cp;
    }

    function _hashPush(IndexPush calldata p) private pure returns (bytes32) {
        uint256 n = p.entries.length;
        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            IndexEntry calldata e = p.entries[i];
            hashes[i] = keccak256(abi.encode(ENTRY_TYPEHASH, e.blokeId, e.b, e.h, e.w));
        }
        return keccak256(
            abi.encode(PUSH_TYPEHASH, p.seq, p.tsMs, p.paramsVersion, keccak256(abi.encodePacked(hashes)))
        );
    }

    // ---------------------------------------------------------------- views

    function hashPush(IndexPush calldata p) external view returns (bytes32) {
        return _hashTypedDataV4(_hashPush(p));
    }

    function latest(uint32 blokeId) external view returns (LatestView memory v) {
        Latest memory l = _latest[blokeId];
        v = LatestView(l.b, l.h, l.w, l.tsMs, l.lag, _fresh(l.tsMs), l.tracked);
    }

    function value(uint32 blokeId, Leg leg) external view returns (uint32 v, uint64 tsMs, bool fresh) {
        Latest memory l = _latest[blokeId];
        v = leg == Leg.Blend ? l.b : leg == Leg.Hype ? l.h : l.w;
        return (v, l.tsMs, _fresh(l.tsMs));
    }

    /// @notice Everything the engine needs for one leg in a single call (value, freshness, lag, paused).
    function read(uint32 blokeId, Leg leg) external view returns (uint32 v, bool fresh, int8 lag, bool isPaused) {
        Latest memory l = _latest[blokeId];
        v = leg == Leg.Blend ? l.b : leg == Leg.Hype ? l.h : l.w;
        fresh = _fresh(l.tsMs);
        uint8 bits = (l.lag >> (2 * uint8(leg))) & 3;
        lag = bits == 1 ? int8(1) : bits == 2 ? int8(-1) : int8(0);
        isPaused = paused;
    }

    /// @return +1 if the signed raw value is above the applied one (later pushes will rise),
    ///         -1 if below, 0 if not lagging.
    function lagDirection(uint32 blokeId, Leg leg) external view returns (int8) {
        uint8 bits = (_latest[blokeId].lag >> (2 * uint8(leg))) & 3;
        return bits == 1 ? int8(1) : bits == 2 ? int8(-1) : int8(0);
    }

    /// @notice Mean of the last `days_` daily averages of hourly checkpoints, with today's running
    /// average (completed hours plus the latest value) as the newest day. Days without data are skipped;
    /// `nDays` says how many contributed.
    function avg(uint32 blokeId, uint256 days_) public view returns (uint32 b, uint32 h, uint32 w, uint256 nDays) {
        if (days_ == 0 || days_ > DAILY_SLOTS) revert WindowTooLong();
        Latest memory l = _latest[blokeId];
        if (!l.seen) return (0, 0, 0, 0);
        uint256 today = uint256(l.tsMs) / HOUR_MS / 24;
        uint256 sb;
        uint256 sh;
        uint256 sw;
        Day[DAILY_SLOTS] storage ring = _daily[blokeId];
        for (uint256 i; i < days_ && i <= today; ++i) {
            uint256 day = today - i;
            Day memory d = ring[day % DAILY_SLOTS];
            uint256 cnt = d.day == day + 1 ? d.count : 0;
            uint256 db = d.day == day + 1 ? d.sumB : 0;
            uint256 dh = d.day == day + 1 ? d.sumH : 0;
            uint256 dw = d.day == day + 1 ? d.sumW : 0;
            if (i == 0) {
                cnt += 1;
                db += l.b;
                dh += l.h;
                dw += l.w;
            }
            if (cnt == 0) continue;
            sb += db / cnt;
            sh += dh / cnt;
            sw += dw / cnt;
            ++nDays;
        }
        return (uint32(sb / nDays), uint32(sh / nDays), uint32(sw / nDays), nDays);
    }

    function avg14(uint32 blokeId) external view returns (uint32 b, uint32 h, uint32 w, uint256 nDays) {
        return avg(blokeId, 14);
    }

    /// @notice Time-weighted value over the last `seconds_` (≤ 60 minutes) at one-minute resolution,
    /// used for SettleOnly prices. Each minute counts the value in effect during it: that minute's sample
    /// if there is one, else the last earlier sample (minutes before the first sample in the window take
    /// the first sample). With pushes at least every 30 s every minute has a sample.
    function twap(uint32 blokeId, Leg leg, uint256 seconds_) external view returns (uint32) {
        if (seconds_ == 0 || seconds_ > 60 minutes) revert WindowTooLong();
        Latest memory l = _latest[blokeId];
        if (!l.seen) return 0;
        uint256 lv = leg == Leg.Blend ? l.b : leg == Leg.Hype ? l.h : l.w;
        uint256 nowMs = block.timestamp * 1000;
        if (nowMs < l.tsMs) nowMs = l.tsMs;
        uint256 endMinute = nowMs / MINUTE_MS;
        uint256 startMinute = (nowMs - seconds_ * 1000) / MINUTE_MS;
        Obs[MINUTE_SLOTS] storage ring = _minutes[blokeId];

        uint256 sum;
        uint256 n;
        uint256 cur;
        uint256 leading; // minutes before the first sample in the window, backfilled with it
        for (uint256 m = startMinute; m < endMinute; ++m) {
            Obs memory o = ring[m % MINUTE_SLOTS];
            if (o.tsMs != 0 && uint256(o.tsMs) / MINUTE_MS == m) {
                uint256 v = leg == Leg.Blend ? o.b : leg == Leg.Hype ? o.h : o.w;
                if (cur == 0) {
                    sum += v * leading;
                    n += leading;
                }
                cur = v;
            }
            if (cur == 0) {
                ++leading;
                continue;
            }
            sum += cur;
            ++n;
        }
        sum += lv; // the current minute counts the latest value
        n += 1;
        return uint32(sum / n);
    }

    function hasFullDay(uint32 blokeId) external view returns (bool) {
        return hasHistory(blokeId, 24);
    }

    /// @notice True once the Bloke has been pushed across at least `hours_` hour boundaries.
    function hasHistory(uint32 blokeId, uint256 hours_) public view returns (bool) {
        Latest memory l = _latest[blokeId];
        return l.seen && uint256(l.tsMs) / HOUR_MS >= uint256(l.firstHour) + hours_;
    }

    function _fresh(uint256 tsMs) private view returns (bool) {
        if (tsMs == 0) return false;
        uint256 nowMs = block.timestamp * 1000;
        return nowMs <= tsMs || nowMs - tsMs <= uint256(params.freshSec) * 1000;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Registry role: start or stop accepting entries for a Bloke (unknown, frozen, settle-only).
    function setTracked(uint32 blokeId, bool tracked) external restricted {
        _latest[blokeId].tracked = tracked;
        emit TrackedSet(blokeId, tracked);
    }

    /// @notice GUARDIAN role.
    function pause() external restricted {
        paused = true;
        emit OraclePausedSet(true);
    }

    /// @notice ADMIN role.
    function unpause() external restricted {
        paused = false;
        emit OraclePausedSet(false);
    }
}
