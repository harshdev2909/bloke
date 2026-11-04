// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BlokeRaise} from "../../src/raise/BlokeRaise.sol";

contract BlokeRaiseTest is BaseTest {
    BlokeRaise internal raise;
    address internal person = makeAddr("person");
    uint32 internal id;

    function setUp() public override {
        super.setUp();
        raise = new BlokeRaise(address(manager), IERC20(address(usdc)), registry);
        vm.startPrank(admin);
        usdc.mint(alice, 100_000e6);
        usdc.mint(bob, 100_000e6);
        usdc.mint(person, 100_000e6);
        vm.stopPrank();
        id = _list("ALICE");
        _claim();
        for (uint256 i; i < 3; ++i) {
            address w = [alice, bob, person][i];
            vm.prank(w);
            usdc.approve(address(raise), type(uint256).max);
        }
    }

    function _claim() internal {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sign712(
            _domainSeparator("BLOKE Registry", address(registry)),
            keccak256(abi.encode(registry.CLAIM_TYPEHASH(), id, person, uint256(1), expiry)),
            attesterPk
        );
        vm.prank(person);
        registry.claim(id, 1, expiry, sig);
    }

    function _open(uint256 goal) internal returns (uint256 r) {
        vm.prank(person);
        r = raise.open(id, goal, 7 days, 100e6);
    }

    function test_onlyClaimedWalletOpens_oneAtATime() public {
        vm.prank(alice);
        vm.expectRevert(BlokeRaise.NotClaimedWallet.selector);
        raise.open(id, 10_000e6, 7 days, 100e6);
        uint256 r = _open(10_000e6);
        vm.prank(person);
        vm.expectRevert(BlokeRaise.AlreadyRaising.selector);
        raise.open(id, 10_000e6, 7 days, 100e6);
        vm.prank(person);
        raise.cancel(r);
        vm.prank(person);
        vm.expectRevert(BlokeRaise.BadGoal.selector);
        raise.open(id, 10e6, 7 days, 1e6);
    }

    function test_success_hardCap_withdraw() public {
        uint256 r = _open(5_000e6);
        vm.prank(alice);
        raise.commit(r, 3_000e6);
        vm.prank(bob);
        uint256 taken = raise.commit(r, 4_000e6); // only 2,000 of room left
        assertEq(taken, 2_000e6);
        assertEq(usdc.balanceOf(bob), 98_000e6);
        assertEq(uint256(raise.stateOf(r)), uint256(BlokeRaise.State.Succeeded));
        vm.prank(alice);
        vm.expectRevert(BlokeRaise.NotOpen.selector);
        raise.commit(r, 100e6);
        uint256 before = usdc.balanceOf(person);
        vm.prank(person);
        raise.withdraw(r);
        assertEq(usdc.balanceOf(person) - before, 5_000e6);
        assertEq(raise.raiseInfo(r).backers, 2);
    }

    function test_failedRaiseRefundsEveryone() public {
        uint256 r = _open(50_000e6);
        vm.prank(alice);
        raise.commit(r, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(BlokeRaise.NotRefundable.selector);
        raise.refund(r);
        vm.warp(vm.getBlockTimestamp() + 8 days);
        assertEq(uint256(raise.stateOf(r)), uint256(BlokeRaise.State.Failed));
        vm.prank(person);
        vm.expectRevert(BlokeRaise.NotSucceeded.selector);
        raise.withdraw(r);
        vm.prank(alice);
        raise.refund(r);
        assertEq(usdc.balanceOf(alice), 100_000e6);
        vm.prank(alice);
        vm.expectRevert(BlokeRaise.NothingToRefund.selector);
        raise.refund(r);
        // A new raise can open after a failed one.
        _open(2_000e6);
    }

    function test_cancelAndNoSelfDealing() public {
        uint256 r = _open(10_000e6);
        vm.prank(person);
        vm.expectRevert(BlokeRaise.SelfCommit.selector);
        raise.commit(r, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(BlokeRaise.BelowMinimum.selector);
        raise.commit(r, 50e6);
        vm.prank(bob);
        raise.commit(r, 500e6);
        vm.prank(person);
        raise.cancel(r);
        vm.prank(bob);
        raise.refund(r);
        assertEq(usdc.balanceOf(bob), 100_000e6);
    }
}
