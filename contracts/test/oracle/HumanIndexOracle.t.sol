// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {HumanIndexOracle} from "../../src/oracle/HumanIndexOracle.sol";
import {IHumanIndexOracle} from "../../src/interfaces/IHumanIndexOracle.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";

contract HumanIndexOracleTest is BaseTest {
    uint32 internal id;
    uint32 constant V100 = 1_000_000;

    function setUp() public override {
        super.setUp();
        id = _list("ALICE");
    }

    // ------------------------------------------------------------ signature / seq / time

    function test_firstPushStoresValues() public {
        _push1(id, V100, 900_000, 1_100_000);
        IHumanIndexOracle.LatestView memory l = oracle.latest(id);
        assertEq(l.b, V100);
        assertEq(l.h, 900_000);
        assertEq(l.w, 1_100_000);
        assertTrue(l.fresh);
        assertEq(l.lagFlags, 0);
        assertEq(oracle.lastSeq(), 1);
    }

    function test_revert_badSignature() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](1);
        e[0] = _entry(id, V100, V100, V100);
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        bytes memory sig = _signPush(p, 0xBAD);
        vm.expectRevert(HumanIndexOracle.BadSignature.selector);
        oracle.push(p, sig);
    }

    function test_revert_tamperedEntry() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](1);
        e[0] = _entry(id, V100, V100, V100);
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        p.entries[0].b = 1_500_000;
        vm.expectRevert(HumanIndexOracle.BadSignature.selector);
        oracle.push(p, sig);
    }

    function test_revert_badSeq() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](0);
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(2, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.BadSeq.selector);
        oracle.push(p, sig);
    }

    function test_revert_stalePush() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](0);
        IHumanIndexOracle.IndexPush memory p =
            IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000 - 30_001), "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.StalePush.selector);
        oracle.push(p, sig);
    }

    function test_revert_futurePush() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](0);
        IHumanIndexOracle.IndexPush memory p =
            IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000 + 3_001), "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.FuturePush.selector);
        oracle.push(p, sig);
    }

    function test_revert_nonIncreasingTs_sameSecondBlocks() public {
        // Monad: several blocks share vm.getBlockTimestamp(). Ordering is by seq; tsMs must still increase.
        uint64 t = uint64(vm.getBlockTimestamp() * 1000);
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](0);
        _pushAt(e, t + 100);
        _pushAt(e, t + 400); // same vm.getBlockTimestamp(), later ms: fine
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(seq + 1, t + 400, "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.StalePush.selector);
        oracle.push(p, sig);
    }

    function test_revert_tooManyEntries() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](33);
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.TooManyEntries.selector);
        oracle.push(p, sig);
    }

    function test_signerRotation_oldSignerRejected() public {
        uint256 newPk = 0xC0FFEE;
        vm.prank(admin);
        config.setAddress("ORACLE_SIGNER", vm.addr(newPk));
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](0);
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        bytes memory oldSig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.BadSignature.selector);
        oracle.push(p, oldSig);
        oracle.push(p, _signPush(p, newPk));
    }

    // ------------------------------------------------------------ clamps and lag

    function test_rangeClamp_noLag() public {
        _push1(id, 1, 3_000_000, V100);
        IHumanIndexOracle.LatestView memory l = oracle.latest(id);
        assertEq(l.b, 5_000);
        assertEq(l.h, 2_000_000);
        assertEq(l.lagFlags, 0, "absolute range never lags");
    }

    function test_stepClamp_setsLagFlags() public {
        _push1(id, V100, V100, V100);
        vm.warp(vm.getBlockTimestamp() + 5);
        _push1(id, 1_200_000, 800_000, 1_010_000);
        IHumanIndexOracle.LatestView memory l = oracle.latest(id);
        assertEq(l.b, 1_030_000, "+3% step");
        assertEq(l.h, 970_000, "-3% step");
        assertEq(l.w, 1_010_000, "inside step");
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Blend), int8(1));
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Hype), int8(-1));
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Work), int8(0));
    }

    function test_lagClearsWhenCaughtUp() public {
        _push1(id, V100, V100, V100);
        vm.warp(vm.getBlockTimestamp() + 5);
        _push1(id, 1_050_000, V100, V100);
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Blend), int8(1));
        vm.warp(vm.getBlockTimestamp() + 5);
        _push1(id, 1_050_000, V100, V100);
        assertEq(oracle.latest(id).b, 1_050_000);
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Blend), int8(0));
    }

    function test_dailyBand_bindsAfterADay() public {
        _push1(id, V100, V100, V100);
        _warmHours(id, 24, V100);
        // Ramp toward 2x for many pushes in the same hour; the band caps at 1.4x the value 24h ago.
        for (uint256 i; i < 40; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _push1(id, 2_000_000, V100, V100);
        }
        assertEq(oracle.latest(id).b, 1_400_000);
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Blend), int8(1));
    }

    function test_compromisedSigner_boundedMovePerDay() public {
        _push1(id, V100, V100, V100);
        _warmHours(id, 24, V100);
        // 10 minutes of hostile 5-second pushes at the floor
        for (uint256 i; i < 120; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _push1(id, 5_000, 5_000, 5_000);
        }
        assertEq(oracle.latest(id).b, 600_000, "cannot fall below 0.6x of 24h ago");
    }

    function test_untrackedSkipped() public {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](2);
        e[0] = _entry(id, V100, V100, V100);
        e[1] = _entry(999, V100, V100, V100);
        vm.expectEmit(true, false, false, false, address(oracle));
        emit HumanIndexOracle.EntrySkipped(999);
        _push(e);
        assertEq(oracle.latest(999).b, 0);
        assertEq(oracle.latest(id).b, V100);
    }

    function test_freshness() public {
        _push1(id, V100, V100, V100);
        vm.warp(vm.getBlockTimestamp() + 60);
        assertTrue(oracle.latest(id).fresh);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertFalse(oracle.latest(id).fresh);
    }

    // ------------------------------------------------------------ checkpoints / averages / twap

    function test_hasFullDay() public {
        _push1(id, V100, V100, V100);
        _warmHours(id, 23, V100);
        assertFalse(oracle.hasFullDay(id));
        _warmHours(id, 1, V100);
        assertTrue(oracle.hasFullDay(id));
    }

    function test_avg_overDays() public {
        // Day-align: start at a UTC midnight.
        vm.warp(((vm.getBlockTimestamp() / 1 days) + 1) * 1 days);
        _push1(id, V100, V100, V100);
        _warmHours(id, 24, V100); // day 0: hours at 100
        // day 1: ramp to 120 in 3% steps (lags shortly), then hold
        for (uint256 i; i < 24; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _push1(id, 1_200_000, V100, V100);
        }
        (uint32 b,,, uint256 n) = oracle.avg(id, 3);
        assertEq(n, 3);
        assertGt(b, V100);
        assertLt(b, 1_200_000);
        (uint32 b1,,, uint256 n1) = oracle.avg(id, 1);
        assertEq(n1, 1);
        assertEq(b1, 1_200_000, "today = completed hours + latest, all at 120");
    }

    function test_twap_lastHour() public {
        _push1(id, V100, V100, V100);
        for (uint256 i; i < 30; ++i) {
            vm.warp(vm.getBlockTimestamp() + 60);
            _push1(id, V100, V100, V100);
        }
        for (uint256 i; i < 30; ++i) {
            vm.warp(vm.getBlockTimestamp() + 60);
            _push1(id, 1_030_000, V100, V100);
        }
        uint32 t = oracle.twap(id, IHumanIndexOracle.Leg.Blend, 60 minutes);
        // ~half the hour at 100, half at 103
        assertApproxEqAbs(t, 1_015_000, 1_500);
        assertEq(oracle.twap(id, IHumanIndexOracle.Leg.Hype, 60 minutes), V100);
    }

    // ------------------------------------------------------------ pause roles

    function test_guardianPauses_adminUnpauses() public {
        vm.prank(guardian);
        oracle.pause();
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](0);
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(1, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        bytes memory sig = _signPush(p, signerPk);
        vm.expectRevert(HumanIndexOracle.OraclePaused.selector);
        oracle.push(p, sig);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, guardian));
        oracle.unpause();

        vm.prank(admin);
        oracle.unpause();
        oracle.push(p, sig);
    }

    function test_onlyRegistrySetsTracked() public {
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, alice));
        vm.prank(alice);
        oracle.setTracked(id, false);
    }

    // ------------------------------------------------------------ invariants as fuzz

    /// I6: every stored value stays within [0.5, 200] and moves at most one step per push.
    function testFuzz_valuesBounded(uint32[8] memory raws) public {
        _push1(id, V100, V100, V100);
        uint32 prev = V100;
        for (uint256 i; i < raws.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _push1(id, raws[i], raws[i], raws[i]);
            uint32 b = oracle.latest(id).b;
            assertGe(b, 5_000);
            assertLe(b, 2_000_000);
            assertLe(b, (uint256(prev) * 10_300) / 10_000);
            assertGe(uint256(b) * 10_000, uint256(prev) * 9_700);
            prev = b;
        }
    }
}
