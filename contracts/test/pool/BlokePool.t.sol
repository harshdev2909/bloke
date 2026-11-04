// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketEngine} from "../../src/engine/MarketEngine.sol";
import {BlokePool} from "../../src/pool/BlokePool.sol";
import {IBlokePool} from "../../src/interfaces/IBlokePool.sol";
import {IProtocolConfig} from "../../src/interfaces/IProtocolConfig.sol";
import {IHumanIndexOracle} from "../../src/interfaces/IHumanIndexOracle.sol";
import {Keys} from "../../src/config/Keys.sol";
import {Wiring} from "../../script/Wiring.sol";

contract BlokePoolTest is BaseTest {
    MarketEngine internal engine;
    BlokePool internal pool;
    uint32 internal id;
    uint32 internal mB;
    uint32 constant V100 = 1_000_000;
    address internal edgeLp = makeAddr("edgeLp");
    address internal floorLp = makeAddr("floorLp");
    address internal person = makeAddr("person");
    uint32 internal curB = V100;

    function setUp() public override {
        super.setUp();
        pool = new BlokePool(address(manager), IERC20(address(usdc)), IProtocolConfig(address(config)), registry);
        engine = new MarketEngine(address(manager), IProtocolConfig(address(config)), oracle, registry, IBlokePool(address(pool)), IERC20(address(usdc)));
        vm.startPrank(admin);
        Wiring.wireP2(manager, config, registry, engine, pool, guardian);
        for (uint256 i; i < 3; ++i) usdc.mint([edgeLp, floorLp, alice][i], 5_000_000e6);
        usdc.mint(bob, 100_000e6);
        usdc.mint(person, 10_000e6);
        vm.stopPrank();

        id = _list("ALICE");
        mB = engine.marketIdOf(id, 0);
        _push1(id, V100, V100, V100);
        _warmHours(id, 72, V100);
        vm.prank(lister);
        registry.goLive(id);

        address[3] memory who = [alice, bob, person];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
        vm.prank(edgeLp);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(floorLp);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(person);
        usdc.approve(address(pool), type(uint256).max);

        _seed();
    }

    // ------------------------------------------------------------ helpers

    /// Edge 1,000,000 and a Floor series of 2,000,000 at 12% for 7 days, both live after the first crank.
    function _seed() internal {
        vm.prank(edgeLp);
        pool.requestDeposit(1_000_000e6);
        vm.prank(admin);
        pool.createSeries(1_200, uint64(vm.getBlockTimestamp() + 1), 7 days);
        vm.prank(floorLp);
        pool.subscribe(0, 2_000_000e6);
        vm.warp(vm.getBlockTimestamp() + 2);
        _push1(id, curB, V100, V100);
        pool.crankEpoch(); // epoch 0: deposit processed, series started
        vm.prank(edgeLp);
        pool.claimDeposit(0);
        vm.prank(floorLp);
        pool.claimSubscription(0);
    }

    function _tick() internal {
        vm.warp(vm.getBlockTimestamp() + 1);
        _push1(id, curB, V100, V100);
    }

    function _moveTo(uint32 b) internal {
        curB = b;
        for (uint256 i; i < 100; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _push1(id, b, V100, V100);
            if (oracle.latest(id).b == b) return;
        }
        revert("no converge");
    }

    function _ids(uint64 a) internal pure returns (uint64[] memory xs) {
        xs = new uint64[](1);
        xs[0] = a;
    }

    function _openFilled(address who, int8 side, uint96 c) internal returns (uint64 lotId) {
        vm.prank(who);
        uint64 o = engine.requestOpen(mB, side, c, 300, 0);
        _tick();
        engine.settle(_ids(o));
        require(engine.order(o).status == MarketEngine.OrderStatus.Filled, "fill");
        lotId = (uint64(mB) << 32) | engine.market(mB).lotCount;
    }

    function _close(address who, uint64 lotId) internal {
        vm.prank(who);
        uint64 o = engine.requestClose(lotId, 1_000);
        _tick();
        engine.settle(_ids(o));
    }

    function _crank() internal {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        _push1(id, curB, V100, V100);
        pool.crankEpoch();
    }

    struct Snap {
        uint256 F;
        uint256 E;
        uint256 R;
        uint256 T;
    }

    function _snap() internal view returns (Snap memory s) {
        (s.F, s.E, s.R, s.T,,,,,) = pool.nav();
    }

    /// I2 (pool side): cash − escrow + traders' unrealised liability = F + E + R + T + Σ Skin.
    function _assertCash() internal view {
        Snap memory s = _snap();
        int256 unreal = engine.tradersUnrealized(mB) + engine.tradersUnrealized(mB + 1) + engine.tradersUnrealized(mB + 2);
        int256 lhs = int256(usdc.balanceOf(address(pool))) - int256(pool.escrowed()) - unreal / 1e12;
        int256 rhs = int256(s.F + s.E + s.R + s.T + pool.skin(id));
        assertApproxEqAbs(lhs, rhs, 10, "pool cash invariant");
    }

    // ------------------------------------------------------------ tests

    function test_seed_capBaseAndShares() public view {
        Snap memory s = _snap();
        assertEq(s.E, 1_000_000e6);
        assertEq(s.F, 2_000_000e6);
        assertEq(pool.capBase(), 1_000_000e6);
        assertGt(pool.edgeShares().balanceOf(edgeLp), 0);
        assertEq(pool.series(0).token.balanceOf(floorLp), 2_000_000e6);
        _assertCash();
    }

    function test_revert_crankTooEarly() public {
        vm.expectRevert(BlokePool.EpochNotOver.selector);
        pool.crankEpoch();
    }

    /// I1: ΔF + ΔE + ΔR + ΔT = G, with Floor accruing its fixed rate.
    function test_traderLoses_feeReserveTreasury_edgeGrows() public {
        uint64 lot = _openFilled(alice, 1, 5_000e6);
        _moveTo(900_000); // −10%
        _close(alice, lot);
        Snap memory a = _snap();
        uint256 started = pool.epochStart();
        _crank();
        uint256 dt = vm.getBlockTimestamp() - started;
        Snap memory b = _snap();
        assertGt(b.E, a.E, "Edge earns the residual");
        assertGt(b.R, a.R, "half the fee tops up the Reserve");
        assertGt(b.T, a.T, "the rest to treasury");
        assertGt(b.F, a.F, "Floor accrues 12% APR");
        // accrual over the epoch's actual length on 2M at 12%
        assertApproxEqAbs(b.F - a.F, (uint256(2_000_000e6) * 1_200 * dt) / (10_000 * 365 days), 2);
        _assertCash();
    }

    function test_traderWins_edgeFundsLossAndAccrual() public {
        uint64 lot = _openFilled(alice, 1, 5_000e6);
        _moveTo(1_100_000); // +10%
        _close(alice, lot);
        Snap memory a = _snap();
        _crank();
        Snap memory b = _snap();
        assertLt(b.E, a.E, "Edge pays the winner and Floor's accrual");
        assertEq(b.R, a.R);
        assertEq(b.T, a.T);
        int256 delta = int256(b.F + b.E + b.R + b.T) - int256(a.F + a.E + a.R + a.T);
        assertApproxEqAbs(delta, -int256(uint256(450e6)), 60e6, "about minus the trader gain");
        _assertCash();
    }

    function test_unrealised_marksEdge_noCashMoves() public {
        _openFilled(alice, 1, 5_000e6);
        _moveTo(1_100_000);
        uint256 cashBefore = usdc.balanceOf(address(pool));
        Snap memory a = _snap();
        _crank();
        Snap memory b = _snap();
        assertLt(b.E, a.E, "Edge NAV is mark-to-market");
        assertEq(usdc.balanceOf(address(pool)), cashBefore, "no cash moved");
        _assertCash();
    }

    function test_edgeRedeem_boundBySubordination() public {
        // F = 2M, so E must stay ≥ 500k: redeeming everything fills only ~50%.
        uint256 shares = pool.edgeShares().balanceOf(edgeLp);
        vm.startPrank(edgeLp);
        pool.edgeShares().approve(address(pool), shares);
        pool.requestRedeem(shares);
        vm.stopPrank();
        uint256 ep = pool.epoch();
        _crank();
        uint256 before = usdc.balanceOf(edgeLp);
        vm.prank(edgeLp);
        pool.claimRedeem(ep);
        uint256 got = usdc.balanceOf(edgeLp) - before;
        assertApproxEqAbs(got, 500_000e6, 1_000e6);
        assertGt(pool.edgeShares().balanceOf(edgeLp), shares / 3, "unfilled shares come back");
        (,,,, uint256 subBps,,,,) = pool.nav();
        assertGe(subBps, 1_999);
        _assertCash();
    }

    function test_depositAtPostWaterfallNav() public {
        vm.prank(edgeLp);
        pool.requestDeposit(100_000e6);
        uint256 ep = pool.epoch();
        _crank();
        uint256 before = pool.edgeShares().balanceOf(edgeLp);
        vm.prank(edgeLp);
        pool.claimDeposit(ep);
        assertGt(pool.edgeShares().balanceOf(edgeLp), before);
        _assertCash();
    }

    function test_skin_absorbsRealisedLoss_andLocksWhileOwed() public {
        _claim(person);
        vm.prank(person);
        pool.postSkin(id, 2_000e6);
        assertTrue(pool.hasSkin(id));
        uint64 lot = _openFilled(alice, 1, 5_000e6);
        _moveTo(1_100_000);
        _close(alice, lot);
        _crank();
        assertLt(pool.skin(id), 2_000e6, "skin took first loss");
        _assertCash();

        // While traders hold winning positions on the person's markets, that much Skin stays locked.
        _openFilled(bob, 1, 5_000e6);
        _moveTo(1_200_000);
        uint256 s = pool.skin(id);
        vm.prank(person);
        pool.requestSkinWithdraw(id, s);
        uint256 before = usdc.balanceOf(person);
        _crank();
        assertLt(usdc.balanceOf(person) - before, s, "locked part stays");
    }

    function test_skin_raisesCreatorShare() public {
        _claim(person);
        uint64 lot = _openFilled(alice, 1, 5_000e6);
        _moveTo(1_100_000);
        _close(alice, lot);
        uint256 base = registry.creatorBalance(id);
        vm.prank(person);
        pool.postSkin(id, 1_000e6);
        uint64 lot2 = _openFilled(bob, 1, 5_000e6);
        _moveTo(1_200_000);
        _close(bob, lot2);
        uint256 withSkin = registry.creatorBalance(id) - base;
        // second fee is similar in size; its creator share is 25% instead of 15%
        assertGt(withSkin * 100, base * 140);
    }

    function test_floorMaturity_redeemsWithAccrual() public {
        for (uint256 i; i < 7; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 days);
            _push1(id, curB, V100, V100);
            pool.crankEpoch();
        }
        assertEq(uint8(pool.series(0).state), uint8(BlokePool.SeriesState.Matured));
        uint256 shares = pool.series(0).token.balanceOf(floorLp);
        uint256 before = usdc.balanceOf(floorLp);
        vm.prank(floorLp);
        pool.redeemFloor(0, shares);
        uint256 got = usdc.balanceOf(floorLp) - before;
        assertApproxEqAbs(got, uint256(2_000_000e6) + (uint256(2_000_000e6) * 1_200 * 7 days) / (10_000 * 365 days), 10e6);
        _assertCash();
    }

    /// Caps bound the pool's loss well inside Edge, so the realistic stop is thin Edge → reduce-only.
    function test_thinEdge_switchesToReduceOnly() public {
        // Shrink Edge so a large trader win exceeds E + R.
        uint256 shares = pool.edgeShares().balanceOf(edgeLp);
        vm.startPrank(admin);
        config.set(Keys.SUBORDINATION_BPS, 1_000);
        config.set(Keys.NET_CAP_MARKET_BPS, 2_000);
        vm.stopPrank();
        vm.startPrank(edgeLp);
        pool.edgeShares().approve(address(pool), shares);
        pool.requestRedeem((shares * 77) / 100);
        vm.stopPrank();
        _crank();
        (, uint256 e,,,,,,,) = pool.nav();
        assertLt(e, 300_000e6);
        // Eight winners × 5,000 (inside the 20% per-market cap on the smaller Edge).
        uint64[] memory lots = new uint64[](8);
        for (uint256 i; i < 8; ++i) {
            address w = makeAddr(string(abi.encode("w", i)));
            vm.prank(admin);
            usdc.mint(w, 5_000e6);
            vm.prank(w);
            usdc.approve(address(engine), type(uint256).max);
            lots[i] = _openFilled(w, 1, 5_000e6);
            vm.warp(vm.getBlockTimestamp() + 1200);
        }
        vm.prank(admin);
        config.set(Keys.MIN_EDGE_USDC, 250_000e6);
        _moveTo(1_400_000);
        _crank();
        assertTrue(engine.globalReduceOnly(), "thin Edge switches markets to reduce-only");
        _assertCash();
    }

    function _claim(address wallet) internal {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sign712(
            _domainSeparator("BLOKE Registry", address(registry)),
            keccak256(abi.encode(registry.CLAIM_TYPEHASH(), id, wallet, uint256(42), expiry)),
            attesterPk
        );
        vm.prank(wallet);
        registry.claim(id, 42, expiry, sig);
    }
}
