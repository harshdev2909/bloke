// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineBase} from "./EngineBase.t.sol";
import {MarketEngine} from "../../src/engine/MarketEngine.sol";
import {IHumanIndexOracle} from "../../src/interfaces/IHumanIndexOracle.sol";
import {IBlokeRegistry} from "../../src/interfaces/IBlokeRegistry.sol";
import {Keys} from "../../src/config/Keys.sol";

contract MarketEngineTest is EngineBase {
    // ------------------------------------------------------------ two-step fills (I7)

    function test_open_fillsOnlyAfterNextPush() public {
        uint64 o = _open(alice, mB, 1, 1_000e6);
        engine.settle(_ids(o)); // same seq as the request
        assertEq(uint8(_status(o)), uint8(MarketEngine.OrderStatus.Pending), "I7: no fill at a known price");

        _tickPush();
        engine.settle(_ids(o));
        assertEq(uint8(_status(o)), uint8(MarketEngine.OrderStatus.Filled));

        MarketEngine.Lot memory l = engine.lot((uint64(mB) << 32) | 1);
        // fill = I · (1 + N/(2D)) with N = 1,000 and D = 300,000 (tier 1)
        uint256 expected = uint256(100e18) + (uint256(100e18) * 1_000) / (2 * 300_000);
        assertGe(l.entryPrice, expected, "rounding favours the pool");
        assertApproxEqAbs(l.entryPrice, expected, 100);
        assertEq(l.units, (uint256(1_000e18) * 1e18) / l.entryPrice);
        assertEq(engine.pendingCount(alice), 0);
    }

    function test_settler_pushAndSettle_sameTx() public {
        uint64 o = _open(alice, mW, -1, 500e6);
        vm.warp(vm.getBlockTimestamp() + 1);
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](1);
        e[0] = _entry(id, V100, V100, V100);
        IHumanIndexOracle.IndexPush memory p =
            IHumanIndexOracle.IndexPush(++seq, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        settler.pushAndSettle(p, _signPush(p, signerPk), _ids(o), new uint64[](0));
        assertEq(uint8(_status(o)), uint8(MarketEngine.OrderStatus.Filled));
    }

    // ------------------------------------------------------------ close and fees

    function test_close_profit_feeAndCreatorShare() public {
        uint64 lotId = _openFilled(alice, mB, 1, 1_000e6);
        uint256 cashBefore = _systemCash();
        _moveTo(1_100_000, V100, V100); // +10%
        uint256 balBefore = usdc.balanceOf(alice);
        _close(alice, lotId);
        uint256 payout = usdc.balanceOf(alice) - balBefore;

        MarketEngine.Lot memory l = engine.lot(lotId);
        assertEq(uint8(l.status), uint8(MarketEngine.LotStatus.Closed));
        // ~ +9.6% gross after entry/exit impact; fee 3% of gross; payout ≈ 1,093
        assertGt(payout, 1_085e6);
        assertLt(payout, 1_100e6);
        // creator share = 15% of a ~2.9 tUSDC fee
        assertGt(registry.creatorBalance(id), 0.3e6, "creator fee escrowed for unclaimed Bloke");
        assertLt(registry.creatorBalance(id), 0.6e6);
        assertEq(_systemCash(), cashBefore, "cash conserved");
    }

    function test_close_loss_noFee_poolReceives() public {
        uint64 lotId = _openFilled(alice, mB, 1, 1_000e6);
        _moveTo(900_000, V100, V100);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        _close(alice, lotId);
        assertGt(usdc.balanceOf(address(pool)), poolBefore);
        assertEq(registry.creatorBalance(id), 0, "no fee on a loss");
    }

    // ------------------------------------------------------------ request checks

    function test_revert_oppositeSide() public {
        _open(alice, mB, 1, 100e6);
        vm.prank(alice);
        vm.expectRevert(MarketEngine.OppositeSideOpen.selector);
        engine.requestOpen(mB, -1, 100e6, 100, 0);
        // other markets on the same Bloke are independent
        _open(alice, mH, -1, 100e6);
    }

    function test_revert_selfTrade() public {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sign712(
            _domainSeparator("BLOKE Registry", address(registry)),
            keccak256(abi.encode(registry.CLAIM_TYPEHASH(), id, carol, uint256(1), expiry)),
            attesterPk
        );
        vm.prank(carol);
        registry.claim(id, 1, expiry, sig);
        vm.prank(carol);
        vm.expectRevert(MarketEngine.SelfTrade.selector);
        engine.requestOpen(mW, 1, 100e6, 100, 0);
    }

    function test_revert_limits() public {
        vm.startPrank(alice);
        vm.expectRevert(MarketEngine.BelowMinLot.selector);
        engine.requestOpen(mB, 1, 9e6, 100, 0);
        vm.expectRevert(MarketEngine.WalletCapExceeded.selector);
        engine.requestOpen(mB, 1, 5_001e6, 100, 0);
        vm.expectRevert(MarketEngine.DeadlineTooFar.selector);
        engine.requestOpen(mB, 1, 100e6, 100, uint64(vm.getBlockTimestamp() + 601));
        vm.expectRevert(MarketEngine.SlippageTooHigh.selector);
        engine.requestOpen(mB, 1, 100e6, 1_001, 0);
        for (uint256 i; i < 5; ++i) engine.requestOpen(mB, 1, 100e6, 100, 0);
        vm.expectRevert(MarketEngine.TooManyPending.selector);
        engine.requestOpen(mB, 1, 100e6, 100, 0);
        vm.stopPrank();
    }

    function test_revert_shadowMarket() public {
        uint32 shadowMarket = engine.marketIdOf(_list("BOB"), 0);
        vm.prank(alice);
        vm.expectRevert(MarketEngine.MarketNotTradable.selector);
        engine.requestOpen(shadowMarket, 1, 100e6, 100, 0);
    }

    function test_cancel_after30s_andExpire() public {
        uint64 o = _open(alice, mB, 1, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(MarketEngine.CancelTooEarly.selector);
        engine.cancel(o);
        vm.warp(vm.getBlockTimestamp() + 30);
        uint256 bal = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.cancel(o);
        assertEq(usdc.balanceOf(alice) - bal, 1_000e6);

        uint64 o2 = _open(alice, mB, -1, 200e6); // side freed after cancel
        vm.warp(vm.getBlockTimestamp() + 121);
        engine.expire(_ids(o2));
        assertEq(uint8(_status(o2)), uint8(MarketEngine.OrderStatus.Expired));
        (int8 side,,,) = engine.exposure(alice, mB);
        assertEq(side, 0);
    }

    // ------------------------------------------------------------ rejects

    function test_reject_slippage_refunds() public {
        uint64 o = _open(alice, mB, 1, 1_000e6); // 1% slippage
        _setIndex(1_030_000, V100, V100); // next push +3%
        uint256 bal = usdc.balanceOf(alice);
        _settle(o);
        assertEq(uint8(_status(o)), uint8(MarketEngine.OrderStatus.Rejected));
        assertEq(usdc.balanceOf(alice) - bal, 1_000e6);
    }

    function test_reject_lagging_open_A1() public {
        _moveTo(V100, V100, V100);
        _setIndex(1_500_000, V100, V100); // raw jumps 50%: oracle applies +3% and flags lag
        _tickPush();
        assertEq(oracle.lagDirection(id, IHumanIndexOracle.Leg.Blend), int8(1));

        vm.prank(alice);
        uint64 longO = engine.requestOpen(mB, 1, 1_000e6, 500, 0);
        vm.prank(bob);
        uint64 shortO = engine.requestOpen(mB, -1, 1_000e6, 500, 0);
        _settle(longO);
        engine.settle(_ids(shortO));
        assertEq(uint8(_status(longO)), uint8(MarketEngine.OrderStatus.Rejected), "long would profit from the catch-up");
        assertEq(uint8(_status(shortO)), uint8(MarketEngine.OrderStatus.Filled), "against-the-lag fills");
    }

    function test_defer_lagging_close_A1() public {
        uint64 lotId = _openFilled(bob, mB, -1, 1_000e6);
        _setIndex(1_100_000, V100, V100);
        _tickPush();
        vm.prank(bob);
        uint64 c = engine.requestClose(lotId, 1_000);
        _settle(c);
        // Closing a short is a buy. With the index lagging upward, buying now is cheaper than fair,
        // so the close waits for the catch-up instead of dodging the known move.
        assertEq(uint8(_status(c)), uint8(MarketEngine.OrderStatus.Pending));
        _moveTo(1_100_000, V100, V100);
        engine.settle(_ids(c));
        assertEq(uint8(_status(c)), uint8(MarketEngine.OrderStatus.Filled));
    }

    function test_reject_netCap_reducingStillFills() public {
        // per-market cap: 3% of 1,000,000 = 30,000 tUSDC net. Six wallets × 5,000 fill it.
        for (uint256 i; i < 6; ++i) {
            address t = makeAddr(string(abi.encode("t", i)));
            vm.prank(admin);
            usdc.mint(t, 5_000e6);
            vm.startPrank(t);
            usdc.approve(address(engine), type(uint256).max);
            uint64 o = engine.requestOpen(mB, 1, 5_000e6, 1_000, 0);
            vm.stopPrank();
            _settle(o);
            vm.warp(vm.getBlockTimestamp() + 1200); // let the premium decay so slippage isn't the binding check
        }
        uint64 more = _open(alice, mB, 1, 1_000e6);
        _settle(more);
        assertEq(uint8(_status(more)), uint8(MarketEngine.OrderStatus.Rejected));

        uint64 reduce = _open(bob, mB, -1, 5_000e6);
        _settle(reduce);
        assertEq(uint8(_status(reduce)), uint8(MarketEngine.OrderStatus.Filled), "reducing orders always fill");
    }

    // ------------------------------------------------------------ spreads

    function test_spread_bothLegsFill() public {
        vm.prank(alice);
        (uint64 w, uint64 h) = engine.requestSpread(id, 1, 1_000e6, 100, 0);
        _tickPush();
        engine.settle(_ids(w));
        assertEq(uint8(_status(w)), uint8(MarketEngine.OrderStatus.Filled));
        assertEq(uint8(_status(h)), uint8(MarketEngine.OrderStatus.Filled));
        uint64 g = w < h ? w : h;
        (uint64 la, uint64 lb) = (engine.groupLots(g, 0), engine.groupLots(g, 1));
        assertEq(engine.lot(la).side, 1, "long .WORK");
        assertEq(engine.lot(lb).side, -1, "short .HYPE");

        vm.prank(alice);
        (uint64 ca, uint64 cb) = engine.requestCloseGroup(g, 500);
        _tickPush();
        engine.settle(_ids(ca, cb));
        assertEq(uint8(engine.lot(la).status), uint8(MarketEngine.LotStatus.Closed));
        assertEq(uint8(engine.lot(lb).status), uint8(MarketEngine.LotStatus.Closed));
    }

    function test_spread_oneLegFails_bothRefunded() public {
        // Make .HYPE lag downward so the short HYPE leg would profit → Lagging → both legs rejected.
        _setIndex(V100, 500_000, V100);
        _tickPush();
        uint256 bal = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint64 w, uint64 h) = engine.requestSpread(id, 1, 1_000e6, 500, 0);
        _settle(w);
        assertEq(uint8(_status(w)), uint8(MarketEngine.OrderStatus.Rejected));
        assertEq(uint8(_status(h)), uint8(MarketEngine.OrderStatus.Rejected));
        assertEq(usdc.balanceOf(alice), bal);
    }

    // ------------------------------------------------------------ exhaustion and profit cap

    function test_exhaust_shortAfterIndexDoubles() public {
        uint64 lotId = _openFilled(bob, mB, -1, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(); // nothing to claim
        engine.claim();
        // lift the band: advance a day at a time so the 24h band allows doubling
        for (uint256 d; d < 3; ++d) {
            uint256 next = uint256(oracle.latest(id).b) * 14 / 10;
            _moveTo(uint32(next > 2_000_000 ? 2_000_000 : next), V100, V100);
            _warmCur(24);
        }
        (int256 equity,,, bool ex) = engine.lotView(lotId);
        assertTrue(ex, "equity <= 0");
        assertLe(equity, 0);
        uint256 poolBefore = usdc.balanceOf(address(pool));
        engine.exhaust(_ids(lotId));
        assertEq(uint8(engine.lot(lotId).status), uint8(MarketEngine.LotStatus.Exhausted));
        assertEq(usdc.balanceOf(address(pool)) - poolBefore, 1_000e6, "pool gain capped at collateral");
    }

    function test_profitCap_A5() public {
        uint64 lotId = _openFilled(alice, mB, 1, 1_000e6);
        // Lower the cap to its minimum (+50%) and move the index +60% over two days (24h band ≤ 1.4×).
        vm.prank(admin);
        config.set(Keys.MAX_PROFIT_BPS, 5_000);
        _moveTo(1_400_000, V100, V100);
        _warmCur(24);
        _moveTo(1_600_000, V100, V100);
        uint256 bal = usdc.balanceOf(alice);
        engine.takeProfitCap(_ids(lotId));
        assertEq(uint8(engine.lot(lotId).status), uint8(MarketEngine.LotStatus.ProfitCapped));
        // payout = 1,000 + 500 − 3% × 500 = 1,485
        assertEq(usdc.balanceOf(alice) - bal, 1_485e6);
    }

    // ------------------------------------------------------------ delisting

    function test_delist_settlesAtSnapshot_noFee_claimable() public {
        uint64 lotId = _openFilled(alice, mB, 1, 1_000e6);
        for (uint256 i; i < 61; ++i) {
            vm.warp(vm.getBlockTimestamp() + 60);
            _push1(id, curB, curH, curW);
        }
        vm.prank(lister);
        registry.requestDelist(id);
        assertEq(uint8(engine.market(mB).status), uint8(MarketEngine.Status.ReduceOnly));
        vm.prank(admin);
        registry.approveDelist(id);
        assertEq(uint8(engine.market(mB).status), uint8(MarketEngine.Status.SettleOnly));
        assertEq(uint8(engine.market(mH).status), uint8(MarketEngine.Status.Settled), "no lots: straight to Settled");

        engine.settleDelisted(_ids(lotId));
        assertEq(uint8(engine.market(mB).status), uint8(MarketEngine.Status.Settled));
        // entry ≈ 100.17 (impact), settle at 100.0 with zero premium: small loss, no fee
        uint256 c = engine.claimable(alice);
        assertGt(c, 995e6);
        assertLt(c, 1_000e6);
        assertEq(registry.creatorBalance(id), 0);
        vm.prank(alice);
        engine.claim();
    }

    // ------------------------------------------------------------ funding

    function test_funding_longsPayWhenPremiumPositive() public {
        uint64 longLot = _openFilled(alice, mB, 1, 5_000e6); // pushes premium up ~1.67%
        uint64 shortLot = _openFilled(bob, mB, -1, 1_000e6);
        vm.warp(vm.getBlockTimestamp() + 300);
        uint32[] memory ms = new uint32[](1);
        ms[0] = mB;
        _push1(id, curB, curH, curW);
        engine.poke(ms);
        (,, int256 fLong,) = engine.lotView(longLot);
        (,, int256 fShort,) = engine.lotView(shortLot);
        assertLt(fLong, 0, "crowded longs pay");
        assertGt(fShort, 0, "shorts receive");
    }

    // ------------------------------------------------------------ guardian / status

    function test_freeze_blocksFills_expiresToSettleOnly() public {
        uint64 lotId = _openFilled(alice, mB, 1, 1_000e6);
        vm.prank(guardian);
        engine.freeze(mB);
        vm.prank(alice);
        vm.expectRevert(MarketEngine.MarketNotTradable.selector);
        engine.requestClose(lotId, 100);
        vm.expectRevert(MarketEngine.FreezeNotExpired.selector);
        engine.expireFreeze(mB);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        engine.expireFreeze(mB);
        assertEq(uint8(engine.market(mB).status), uint8(MarketEngine.Status.SettleOnly));
    }

    function test_globalReduceOnly_guardianOnAdminOff() public {
        vm.prank(guardian);
        engine.enableGlobalReduceOnly();
        uint64 o = _open(alice, mB, 1, 100e6);
        _settle(o);
        assertEq(uint8(_status(o)), uint8(MarketEngine.OrderStatus.Rejected));
        vm.prank(guardian);
        vm.expectRevert();
        engine.disableGlobalReduceOnly();
        vm.prank(admin);
        engine.disableGlobalReduceOnly();
    }
}
