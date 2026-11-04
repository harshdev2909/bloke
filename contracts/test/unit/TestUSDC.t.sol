// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {TestUSDC} from "../../src/token/TestUSDC.sol";
import {ProtocolConfig} from "../../src/config/ProtocolConfig.sol";
import {Keys} from "../../src/config/Keys.sol";

contract TestUSDCTest is BaseTest {
    bytes32 internal domain;
    bytes32 internal idHash = keccak256("github:12345");

    function setUp() public override {
        super.setUp();
        domain = _domainSeparator("BLOKE Test USDC", address(usdc));
    }

    function _sig(address wallet, bytes32 identity, uint64 expiry) internal view returns (bytes memory) {
        return _sign712(domain, keccak256(abi.encode(usdc.FAUCET_TYPEHASH(), identity, wallet, expiry)), attesterPk);
    }

    function test_faucet_relayedForGaslessWallet() public {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sig(alice, idHash, expiry);
        vm.prank(makeAddr("relayer"));
        usdc.faucet(alice, idHash, expiry, sig);
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(usdc.decimals(), 6);
    }

    function test_faucet_cooldownPerIdentity() public {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        usdc.faucet(alice, idHash, expiry, _sig(alice, idHash, expiry));
        bytes memory sigBob = _sig(bob, idHash, expiry);
        vm.expectRevert(TestUSDC.FaucetCooldown.selector);
        usdc.faucet(bob, idHash, expiry, sigBob); // second wallet, same identity

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        usdc.faucet(bob, idHash, expiry, _sig(bob, idHash, expiry));
        assertEq(usdc.balanceOf(bob), 10_000e6);
    }

    function test_revert_redirectedRecipient() public {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sig(alice, idHash, expiry);
        vm.expectRevert(TestUSDC.BadAttestation.selector);
        usdc.faucet(bob, idHash, expiry, sig);
    }

    function test_guardianPausesFaucet() public {
        vm.prank(guardian);
        usdc.pauseFaucet();
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sig(alice, idHash, expiry);
        vm.expectRevert(TestUSDC.FaucetIsPaused.selector);
        usdc.faucet(alice, idHash, expiry, sig);
    }

    function test_config_boundsEnforced() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(ProtocolConfig.OutOfBounds.selector, Keys.ORACLE_STEP_BPS, 1_001));
        config.set(Keys.ORACLE_STEP_BPS, 1_001);
        config.set(Keys.ORACLE_STEP_BPS, 500);
        vm.stopPrank();
        assertEq(config.get(Keys.ORACLE_STEP_BPS), 500);
    }
}
