// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketEngine} from "../../src/engine/MarketEngine.sol";
import {Settler} from "../../src/engine/Settler.sol";
import {SimplePool} from "../../src/pool/SimplePool.sol";
import {IBlokePool} from "../../src/interfaces/IBlokePool.sol";
import {IProtocolConfig} from "../../src/interfaces/IProtocolConfig.sol";
import {IHumanIndexOracle} from "../../src/interfaces/IHumanIndexOracle.sol";
import {Wiring} from "../../script/Wiring.sol";

abstract contract EngineBase is BaseTest {
    MarketEngine internal engine;
    Settler internal settler;
    SimplePool internal pool;

    uint32 internal id; // test Bloke
    uint32 internal mB; // $NAME
    uint32 internal mH; // .HYPE
    uint32 internal mW; // .WORK
    uint32 constant V100 = 1_000_000;
    uint256 constant POOL_SEED = 1_000_000e6;

    // current raw values pushed for the test Bloke
    uint32 internal curB = V100;
    uint32 internal curH = V100;
    uint32 internal curW = V100;

    address internal carol = makeAddr("carol");

    function setUp() public virtual override {
        super.setUp();
        pool = new SimplePool(address(manager), IERC20(address(usdc)));
        engine = new MarketEngine(
            address(manager), IProtocolConfig(address(config)), oracle, registry, IBlokePool(address(pool)), IERC20(address(usdc))
        );
        settler = new Settler(oracle, engine);
        vm.startPrank(admin);
        Wiring.wireP1(manager, config, registry, engine, pool);
        usdc.mint(address(pool), POOL_SEED);
        vm.stopPrank();

        id = _list("ALICE");
        mB = engine.marketIdOf(id, 0);
        mH = engine.marketIdOf(id, 1);
        mW = engine.marketIdOf(id, 2);
        _push1(id, V100, V100, V100);
        _warmHours(id, 72, V100);
        vm.prank(lister);
        registry.goLive(id);

        address[3] memory traders = [alice, bob, carol];
        for (uint256 i; i < traders.length; ++i) {
            vm.prank(admin);
            usdc.mint(traders[i], 100_000e6);
            vm.prank(traders[i]);
            usdc.approve(address(engine), type(uint256).max);
        }
    }

    // ------------------------------------------------------------ helpers

    function _tickPush() internal {
        vm.warp(vm.getBlockTimestamp() + 1);
        _push1(id, curB, curH, curW);
    }

    function _setIndex(uint32 b, uint32 h, uint32 w) internal {
        curB = b;
        curH = h;
        curW = w;
    }

    /// Pushes (5 s apart) until the stored values reach the targets through the 3% step clamp.
    function _moveTo(uint32 b, uint32 h, uint32 w) internal {
        _setIndex(b, h, w);
        for (uint256 i; i < 200; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _push1(id, b, h, w);
            IHumanIndexOracle.LatestView memory l = oracle.latest(id);
            if (l.b == b && l.h == h && l.w == w) return;
        }
        revert("did not converge");
    }

    /// Hourly pushes of the current values, so the 24h band follows the index.
    function _warmCur(uint256 hours_) internal {
        for (uint256 i; i < hours_; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _push1(id, curB, curH, curW);
        }
    }

    function _ids(uint64 a) internal pure returns (uint64[] memory xs) {
        xs = new uint64[](1);
        xs[0] = a;
    }

    function _ids(uint64 a, uint64 b) internal pure returns (uint64[] memory xs) {
        xs = new uint64[](2);
        xs[0] = a;
        xs[1] = b;
    }

    function _settle(uint64 orderId) internal {
        _tickPush();
        engine.settle(_ids(orderId));
    }

    function _open(address who, uint32 marketId, int8 side, uint96 collateral) internal returns (uint64 orderId) {
        vm.prank(who);
        orderId = engine.requestOpen(marketId, side, collateral, 100, 0);
    }

    function _openFilled(address who, uint32 marketId, int8 side, uint96 collateral) internal returns (uint64 lotId) {
        uint64 o = _open(who, marketId, side, collateral);
        vm.recordLogs();
        _settle(o);
        MarketEngine.Order memory ord = engine.order(o);
        require(ord.status == MarketEngine.OrderStatus.Filled, "not filled");
        lotId = (uint64(marketId) << 32) | engine.market(marketId).lotCount;
    }

    function _close(address who, uint64 lotId) internal returns (uint64 orderId) {
        vm.prank(who);
        orderId = engine.requestClose(lotId, 500);
        _settle(orderId);
    }

    function _status(uint64 orderId) internal view returns (MarketEngine.OrderStatus) {
        return engine.order(orderId).status;
    }

    /// Total tUSDC across every holder in the system (conservation check).
    function _systemCash() internal view returns (uint256) {
        return usdc.balanceOf(address(engine)) + usdc.balanceOf(address(pool)) + usdc.balanceOf(address(registry))
            + usdc.balanceOf(alice) + usdc.balanceOf(bob) + usdc.balanceOf(carol);
    }
}
