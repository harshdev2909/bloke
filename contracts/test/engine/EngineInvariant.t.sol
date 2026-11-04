// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {EngineBase} from "./EngineBase.t.sol";
import {MarketEngine} from "../../src/engine/MarketEngine.sol";
import {IHumanIndexOracle} from "../../src/interfaces/IHumanIndexOracle.sol";
import {HumanIndexOracle} from "../../src/oracle/HumanIndexOracle.sol";
import {TestUSDC} from "../../src/token/TestUSDC.sol";

/// Random actions against one Bloke's three markets. Tracks every order and lot so invariants can
/// be checked from the outside.
contract EngineHandler is Test {
    MarketEngine internal engine;
    HumanIndexOracle internal oracle;
    TestUSDC internal usdc;
    uint256 internal signerPk;
    uint32 internal id;
    uint64 public seq;
    uint32[3] internal raw = [uint32(1_000_000), 1_000_000, 1_000_000];

    address[] public actors;
    uint64[] public orders;
    uint64[] public lots;

    // ghost variable
    uint256 public fillTimingViolation;

    constructor(MarketEngine e, HumanIndexOracle o, TestUSDC u, uint256 pk, uint32 blokeId, uint64 seq0, address[] memory a) {
        engine = e;
        oracle = o;
        usdc = u;
        signerPk = pk;
        id = blokeId;
        seq = seq0;
        actors = a;
    }

    function ordersLength() external view returns (uint256) {
        return orders.length;
    }

    function lotsLength() external view returns (uint256) {
        return lots.length;
    }

    // ------------------------------------------------------------ actions

    function push(uint256 seedB, uint256 seedH, uint256 seedW, uint256 dt) public {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 90));
        raw[0] = _walk(raw[0], seedB);
        raw[1] = _walk(raw[1], seedH);
        raw[2] = _walk(raw[2], seedW);
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](1);
        e[0] = IHumanIndexOracle.IndexEntry(id, raw[0], raw[1], raw[2]);
        IHumanIndexOracle.IndexPush memory p =
            IHumanIndexOracle.IndexPush(++seq, uint64(vm.getBlockTimestamp() * 1000), "v1", e);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, oracle.hashPush(p));
        oracle.push(p, abi.encodePacked(r, s, v));
    }

    function open(uint256 actorSeed, uint256 legSeed, bool long, uint256 amount) public {
        address a = actors[actorSeed % actors.length];
        uint32 m = engine.marketIdOf(id, uint8(legSeed % 3));
        vm.prank(a);
        try engine.requestOpen(m, long ? int8(1) : int8(-1), uint96(bound(amount, 10e6, 3_000e6)), 300, 0) returns (uint64 o) {
            orders.push(o);
        } catch {}
    }

    function spread(uint256 actorSeed, bool underrated, uint256 amount) public {
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        try engine.requestSpread(id, underrated ? int8(1) : int8(-1), uint96(bound(amount, 20e6, 2_000e6)), 300, 0) returns (
            uint64 w, uint64 h
        ) {
            orders.push(w);
            orders.push(h);
        } catch {}
    }

    function close(uint256 lotSeed) public {
        if (lots.length == 0) return;
        uint64 l = lots[lotSeed % lots.length];
        MarketEngine.Lot memory lot = engine.lot(l);
        vm.prank(lot.owner);
        try engine.requestClose(l, 500) returns (uint64 o) {
            orders.push(o);
        } catch {}
    }

    function settleAll() public {
        uint256 n = orders.length;
        uint256 start = n > 100 ? n - 100 : 0;
        uint64[] memory ids = new uint64[](n - start);
        for (uint256 i = start; i < n; ++i) ids[i - start] = orders[i];
        uint256 lotsBefore;
        for (uint256 i; i < 3; ++i) lotsBefore += engine.market(engine.marketIdOf(id, uint8(i))).lotCount;
        engine.settle(ids);
        // record new lots and check I7 for every order that just filled
        for (uint8 leg; leg < 3; ++leg) {
            uint32 m = engine.marketIdOf(id, leg);
            uint32 count = engine.market(m).lotCount;
            for (uint32 k = 1; k <= count; ++k) {
                uint64 lotId = (uint64(m) << 32) | k;
                if (!_known(lotId)) lots.push(lotId);
            }
        }
        for (uint256 i; i < ids.length; ++i) {
            MarketEngine.Order memory o = engine.order(ids[i]);
            if (o.status == MarketEngine.OrderStatus.Filled && oracle.lastSeq() <= o.seqAtRequest) ++fillTimingViolation;
        }
    }

    function cancelOrExpire(uint256 orderSeed, uint256 dt) public {
        if (orders.length == 0) return;
        uint64 o = orders[orderSeed % orders.length];
        vm.warp(vm.getBlockTimestamp() + bound(dt, 0, 200));
        MarketEngine.Order memory ord = engine.order(o);
        vm.prank(ord.owner);
        try engine.cancel(o) {} catch {}
        uint64[] memory ids = new uint64[](1);
        ids[0] = o;
        engine.expire(ids);
    }

    function exhaustAll() public {
        uint256 n = lots.length > 100 ? 100 : lots.length;
        uint64[] memory ids = new uint64[](n);
        for (uint256 i; i < n; ++i) ids[i] = lots[lots.length - 1 - i];
        engine.exhaust(ids);
        engine.takeProfitCap(ids);
    }

    function poke() public {
        uint32[] memory ms = new uint32[](3);
        for (uint8 i; i < 3; ++i) ms[i] = engine.marketIdOf(id, i);
        engine.poke(ms);
    }

    // ------------------------------------------------------------ helpers

    function _walk(uint32 v, uint256 seed) internal pure returns (uint32) {
        int256 step = int256(seed % 81) - 40; // −4%..+4% raw moves, so clamps and lag flags occur
        int256 nv = int256(uint256(v)) * (1000 + step) / 1000;
        if (nv < 200_000) nv = 200_000;
        if (nv > 1_900_000) nv = 1_900_000;
        return uint32(uint256(nv));
    }

    function _known(uint64 lotId) internal view returns (bool) {
        for (uint256 i; i < lots.length; ++i) if (lots[i] == lotId) return true;
        return false;
    }
}

contract EngineInvariantTest is EngineBase {
    EngineHandler internal handler;
    address[] internal actors;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < 6; ++i) {
            address a = makeAddr(string(abi.encode("actor", i)));
            actors.push(a);
            vm.prank(admin);
            usdc.mint(a, 50_000e6);
            vm.prank(a);
            usdc.approve(address(engine), type(uint256).max);
        }
        handler = new EngineHandler(engine, oracle, usdc, signerPk, id, seq, actors);
        targetContract(address(handler));
    }

    /// Deterministic long run through the same handler: proves the actions reach fills, closes,
    /// rejections and exhaustion, then checks the invariants at the end.
    function test_handlerSmoke_3000Actions() public {
        uint256 r = 12345;
        for (uint256 i; i < 3_000; ++i) {
            r = uint256(keccak256(abi.encode(r)));
            uint256 k = r % 8;
            if (k == 0 || k == 1) handler.push(r >> 8, r >> 16, r >> 24, r >> 32);
            else if (k == 2) handler.open(r >> 8, r >> 16, (r >> 24) % 2 == 0, r >> 32);
            else if (k == 3) handler.spread(r >> 8, (r >> 16) % 2 == 0, r >> 24);
            else if (k == 4) handler.close(r >> 8);
            else if (k == 5) handler.settleAll();
            else if (k == 6) handler.cancelOrExpire(r >> 8, r >> 16);
            else {
                handler.exhaustAll();
                handler.poke();
            }
        }
        uint256[6] memory counts; // open, closed, exhausted, capped, filledOrders, rejectedOrders
        for (uint256 i; i < handler.lotsLength(); ++i) {
            MarketEngine.LotStatus st = engine.lot(handler.lots(i)).status;
            if (st == MarketEngine.LotStatus.Open) ++counts[0];
            else if (st == MarketEngine.LotStatus.Closed) ++counts[1];
            else if (st == MarketEngine.LotStatus.Exhausted) ++counts[2];
            else if (st == MarketEngine.LotStatus.ProfitCapped) ++counts[3];
        }
        for (uint256 i; i < handler.ordersLength(); ++i) {
            MarketEngine.OrderStatus st = engine.order(handler.orders(i)).status;
            if (st == MarketEngine.OrderStatus.Filled) ++counts[4];
            else if (st == MarketEngine.OrderStatus.Rejected) ++counts[5];
        }
        console2.log("lots open", counts[0], "closed", counts[1]);
        console2.log("exhausted", counts[2], "profit-capped", counts[3]);
        console2.log("orders filled", counts[4], "rejected", counts[5]);
        assertGt(counts[1], 20, "closes happen");
        assertGt(counts[4], 100, "fills happen");
        assertGt(counts[5], 0, "rejections happen");
        invariant_engineCash();
        invariant_totalCash();
        invariant_premiumBounded();
        invariant_oneSide();
        invariant_netMatchesLots();
        invariant_fillTiming();
    }

    function afterInvariant() public view {
        uint256 open;
        uint256 closed;
        for (uint256 i; i < handler.lotsLength(); ++i) {
            MarketEngine.LotStatus st = engine.lot(handler.lots(i)).status;
            if (st == MarketEngine.LotStatus.Open) ++open;
            else ++closed;
        }
        console2.log("orders", handler.ordersLength(), "lots open/finished", open * 1000 + closed);
    }

    /// Engine-level cash invariant (part of I2): the engine holds exactly the escrow of pending opens,
    /// the collateral of open lots and the claimable balances.
    function invariant_engineCash() public view {
        uint256 expected;
        for (uint256 i; i < handler.ordersLength(); ++i) {
            MarketEngine.Order memory o = engine.order(handler.orders(i));
            if (o.status == MarketEngine.OrderStatus.Pending && o.kind == MarketEngine.Kind.Open) expected += o.collateral;
        }
        for (uint256 i; i < handler.lotsLength(); ++i) {
            MarketEngine.Lot memory l = engine.lot(handler.lots(i));
            if (l.status == MarketEngine.LotStatus.Open) expected += l.collateral;
        }
        for (uint256 i; i < actors.length; ++i) expected += engine.claimable(actors[i]);
        assertEq(usdc.balanceOf(address(engine)), expected);
    }

    /// Total tUSDC is conserved: trading never mints or burns.
    function invariant_totalCash() public view {
        uint256 total = usdc.balanceOf(address(engine)) + usdc.balanceOf(address(pool)) + usdc.balanceOf(address(registry))
            + usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(carol);
        for (uint256 i; i < actors.length; ++i) total += usdc.balanceOf(actors[i]);
        assertEq(total, POOL_SEED + 3 * 100_000e6 + actors.length * 50_000e6);
    }

    /// I5: |π| ≤ 5% on every market.
    function invariant_premiumBounded() public view {
        for (uint8 leg; leg < 3; ++leg) {
            int256 p = engine.market(engine.marketIdOf(id, leg)).premium;
            assertLe(p < 0 ? -p : p, 0.05e18);
        }
    }

    /// I8: no wallet holds long and short lots on the same market.
    function invariant_oneSide() public view {
        for (uint256 a; a < actors.length; ++a) {
            for (uint8 leg; leg < 3; ++leg) {
                uint32 m = engine.marketIdOf(id, leg);
                bool hasLong;
                bool hasShort;
                for (uint256 i; i < handler.lotsLength(); ++i) {
                    MarketEngine.Lot memory l = engine.lot(handler.lots(i));
                    if (l.owner != actors[a] || l.marketId != m || l.status != MarketEngine.LotStatus.Open) continue;
                    if (l.side > 0) hasLong = true;
                    else hasShort = true;
                }
                assertFalse(hasLong && hasShort);
            }
        }
    }

    /// I7: every filled order filled at a push after its request.
    function invariant_fillTiming() public view {
        assertEq(handler.fillTimingViolation(), 0);
    }

    /// Aggregates match the lots: net = Σ s·u over open lots on each market.
    function invariant_netMatchesLots() public view {
        for (uint8 leg; leg < 3; ++leg) {
            uint32 m = engine.marketIdOf(id, leg);
            int256 net;
            uint256 gross;
            for (uint256 i; i < handler.lotsLength(); ++i) {
                MarketEngine.Lot memory l = engine.lot(handler.lots(i));
                if (l.marketId != m || l.status != MarketEngine.LotStatus.Open) continue;
                net += l.side * int256(uint256(l.units));
                gross += l.collateral;
            }
            assertEq(engine.market(m).net, net);
            assertEq(engine.market(m).grossCollateral, gross);
        }
    }
}
