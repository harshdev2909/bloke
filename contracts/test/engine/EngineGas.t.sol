// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineBase} from "./EngineBase.t.sol";
import {MarketEngine} from "../../src/engine/MarketEngine.sol";
import {Keys} from "../../src/config/Keys.sol";

/// Gas budgets for the hot paths (PRD §19). Monad bills the gas limit, so these regress loudly.
contract EngineGasTest is EngineBase {
    function test_gas_settleOneOpen_andClose() public {
        _openFilled(bob, mB, 1, 1_000e6); // warm the market's slots like a live market
        uint64 o = _open(alice, mB, 1, 1_000e6);
        _tickPush();
        uint256 g = gasleft();
        engine.settle(_ids(o));
        uint256 openGas = g - gasleft();
        uint64 lotId = (uint64(mB) << 32) | engine.market(mB).lotCount;

        vm.prank(alice);
        uint64 c = engine.requestClose(lotId, 500);
        _tickPush();
        g = gasleft();
        engine.settle(_ids(c));
        uint256 closeGas = g - gasleft();
        emit log_named_uint("settle 1 open", openGas);
        emit log_named_uint("settle 1 close", closeGas);
        assertLt(openGas, 300_000); // Anvil pricing; was 355k before params caching and repacking
        assertLt(closeGas, 220_000); // was 260k
    }

    /// Cached parameters follow ProtocolConfig immediately (no stale copy after `set`).
    function test_configChange_propagatesToCaches() public {
        vm.startPrank(admin);
        config.set(Keys.MIN_LOT_USDC, 50e6);
        config.set(Keys.ORACLE_STEP_BPS, 100);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(MarketEngine.BelowMinLot.selector);
        engine.requestOpen(mB, 1, 49e6, 100, 0);

        _setIndex(1_200_000, curH, curW);
        _tickPush();
        assertEq(oracle.latest(id).b, 1_010_000, "new 1% step clamp applies at once");
    }
}
