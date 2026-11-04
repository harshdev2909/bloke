// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IHumanIndexOracle} from "../../src/interfaces/IHumanIndexOracle.sol";

/// Gas budgets (PRD §19). Monad bills the gas limit, so these regress loudly.
contract OracleGasTest is BaseTest {
    uint256 constant N = 25;

    function setUp() public override {
        super.setUp();
        for (uint256 i; i < N; ++i) {
            _list(bytes16(abi.encodePacked("B", bytes1(uint8(65 + i)))));
        }
        _pushAll(1_000_000);
        // Steady state: fill every ring slot once (64 minutes of minute observations, 25 hourly slots).
        for (uint256 i; i < 26 * 6; ++i) {
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            _pushAll(1_000_000);
        }
    }

    function _pushAll(uint32 v) internal {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](N);
        for (uint256 i; i < N; ++i) {
            e[i] = _entry(uint32(i + 1), v, v, v);
        }
        _push(e);
    }

    function test_gas_push25_warm() public {
        vm.warp(vm.getBlockTimestamp() + 5);
        uint256 g = gasleft();
        _pushAll(1_010_000);
        uint256 used = g - gasleft();
        emit log_named_uint("push 25 entries, steady state", used);
        assertLt(used, 600_000); // was 806k before params caching; includes a minute sample and test-side signing
    }

    function test_gas_push25_hourRollover() public {
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        uint256 g = gasleft();
        _pushAll(1_010_000);
        uint256 used = g - gasleft();
        emit log_named_uint("push 25 entries, hour rollover", used);
        assertLt(used, 1_250_000); // was 1.42M
    }
}
