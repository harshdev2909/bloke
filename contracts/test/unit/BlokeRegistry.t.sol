// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {BlokeRegistry} from "../../src/registry/BlokeRegistry.sol";
import {IBlokeRegistry} from "../../src/interfaces/IBlokeRegistry.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {ProtocolConfig} from "../../src/config/ProtocolConfig.sol";

contract BlokeRegistryTest is BaseTest {
    uint32 internal id;
    bytes32 internal domain;

    function setUp() public override {
        super.setUp();
        id = _list("ALICE");
        domain = _domainSeparator("BLOKE Registry", address(registry));
    }

    function _claimSig(uint32 bid, address wallet, uint256 nonce, uint64 expiry) internal view returns (bytes memory) {
        return _sign712(domain, keccak256(abi.encode(registry.CLAIM_TYPEHASH(), bid, wallet, nonce, expiry)), attesterPk);
    }

    function _claim(address wallet) internal {
        uint256 nonce = ++nonceCounter;
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _claimSig(id, wallet, nonce, expiry);
        vm.prank(wallet);
        registry.claim(id, nonce, expiry, sig);
    }

    // ------------------------------------------------------------ listing

    function test_list_setsShadowAndTracks() public view {
        assertEq(uint8(registry.status(id)), uint8(IBlokeRegistry.Status.Shadow));
        assertTrue(oracle.latest(id).tracked);
        assertEq(registry.idByTicker("ALICE"), id);
    }

    function test_revert_invalidTickers() public {
        bytes16[4] memory bad = [bytes16("A"), bytes16("alice"), bytes16("TOOLONGTICKER"), bytes16("AL-1")];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(lister);
            vm.expectRevert(BlokeRegistry.InvalidTicker.selector);
            registry.list(IBlokeRegistry.BlokeInit(bad[i], "x", bytes32(0), 1, 0));
        }
    }

    function test_revert_tickerTaken() public {
        vm.prank(lister);
        vm.expectRevert(BlokeRegistry.TickerTaken.selector);
        registry.list(IBlokeRegistry.BlokeInit("ALICE", "x", bytes32(0), 1, 0));
    }

    function test_revert_listNotLister() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, alice));
        registry.list(IBlokeRegistry.BlokeInit("BOB", "x", bytes32(0), 1, 0));
    }

    function test_goLive_needsShadowPeriodAndFullDay() public {
        vm.prank(lister);
        vm.expectRevert(BlokeRegistry.ShadowNotOver.selector);
        registry.goLive(id);

        vm.warp(vm.getBlockTimestamp() + 72 hours);
        vm.prank(lister);
        vm.expectRevert(BlokeRegistry.ShadowNotOver.selector); // no oracle history yet
        registry.goLive(id);

        _push1(id, 1_000_000, 1_000_000, 1_000_000);
        _warmHours(id, 24, 1_000_000);
        vm.prank(lister);
        registry.goLive(id);
        assertEq(uint8(registry.status(id)), uint8(IBlokeRegistry.Status.Live));
    }

    // ------------------------------------------------------------ claims

    function test_claim() public {
        _claim(alice);
        assertEq(registry.claimedWallet(id), alice);
        assertTrue(registry.isLinked(id, alice));
    }

    function test_revert_claimWrongWallet() public {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _claimSig(id, alice, 1, expiry);
        vm.prank(bob);
        vm.expectRevert(BlokeRegistry.BadAttestation.selector);
        registry.claim(id, 1, expiry, sig);
    }

    function test_revert_claimReplayAndExpiry() public {
        _claim(alice);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _claimSig(id, bob, 1, expiry);
        vm.prank(bob);
        vm.expectRevert(BlokeRegistry.AlreadyClaimed.selector);
        registry.claim(id, 1, expiry, sig);

        uint32 id2 = _list("BOB");
        uint64 far = uint64(vm.getBlockTimestamp() + 11 minutes);
        bytes memory sig2 = _claimSig(id2, bob, 9, far);
        vm.prank(bob);
        vm.expectRevert(BlokeRegistry.Expired.selector);
        registry.claim(id2, 9, far, sig2);
    }

    function test_sourceVerification_linksWallets() public {
        _claim(alice);
        address[] memory linked = new address[](2);
        linked[0] = makeAddr("deployer1");
        linked[1] = makeAddr("deployer2");
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sign712(
            domain,
            keccak256(abi.encode(registry.SOURCES_TYPEHASH(), id, uint8(5), keccak256(abi.encodePacked(linked)), 77, expiry)),
            attesterPk
        );
        vm.prank(alice);
        registry.setSourceVerification(id, 5, linked, 77, expiry, sig);
        assertTrue(registry.isLinked(id, linked[0]));
        assertTrue(registry.isLinked(id, linked[1]));
        assertFalse(registry.isLinked(id, bob));
        assertEq(registry.bloke(id).sourceBitmap, 5);
    }

    function test_rotation_timelockAndCancel() public {
        _claim(alice);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sign712(
            domain, keccak256(abi.encode(registry.ROTATION_TYPEHASH(), id, alice, bob, 55, expiry)), attesterPk
        );
        vm.prank(alice);
        registry.requestRotation(bob, id, 55, expiry, sig);
        assertTrue(registry.isLinked(id, bob), "pending wallet already counts as linked");

        vm.expectRevert(BlokeRegistry.Timelocked.selector);
        registry.finalizeRotation(id);

        vm.warp(vm.getBlockTimestamp() + 72 hours);
        registry.finalizeRotation(id);
        assertEq(registry.claimedWallet(id), bob);
    }

    function test_rotation_blockedWhileFrozen() public {
        _claim(alice);
        vm.prank(guardian);
        registry.freezeClaim(id);
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes memory sig = _sign712(
            domain, keccak256(abi.encode(registry.ROTATION_TYPEHASH(), id, alice, bob, 56, expiry)), attesterPk
        );
        vm.prank(alice);
        vm.expectRevert(BlokeRegistry.ClaimIsFrozen.selector);
        registry.requestRotation(bob, id, 56, expiry, sig);
    }

    // ------------------------------------------------------------ creator fees

    function test_creatorFees_escrowThenWithdrawAfterDelay() public {
        vm.prank(admin);
        usdc.mint(address(registry), 500e6);
        registry.creditCreator(id, 500e6); // escrow while unclaimed

        _claim(alice);
        vm.prank(alice);
        vm.expectRevert(BlokeRegistry.Timelocked.selector);
        registry.withdrawCreatorFees(id);

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(alice);
        registry.withdrawCreatorFees(id);
        assertEq(usdc.balanceOf(alice), 500e6);
    }

    function test_creatorFees_frozen() public {
        _claim(alice);
        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(guardian);
        registry.freezeClaim(id);
        vm.prank(alice);
        vm.expectRevert(BlokeRegistry.ClaimIsFrozen.selector);
        registry.withdrawCreatorFees(id);
    }

    // ------------------------------------------------------------ delisting

    function test_delist_snapshotsTwapAtRequest() public {
        _push1(id, 1_000_000, 1_000_000, 1_000_000);
        for (uint256 i; i < 60; ++i) {
            vm.warp(vm.getBlockTimestamp() + 60);
            _push1(id, 1_000_000, 1_000_000, 1_000_000);
        }
        _claim(alice);
        vm.prank(alice);
        registry.requestDelist(id);
        assertEq(uint8(registry.status(id)), uint8(IBlokeRegistry.Status.DelistPending));
        assertEq(registry.bloke(id).settlePrice[0], 1_000_000);

        // Later pushes cannot move the settlement price.
        vm.warp(vm.getBlockTimestamp() + 5);
        _push1(id, 1_030_000, 1_030_000, 1_030_000);
        vm.prank(admin);
        registry.approveDelist(id);
        assertEq(registry.bloke(id).settlePrice[0], 1_000_000);
        assertFalse(oracle.latest(id).tracked);
    }

    function test_revert_delistByStranger() public {
        vm.prank(bob);
        vm.expectRevert(BlokeRegistry.NotClaimedWallet.selector);
        registry.requestDelist(id);
        vm.prank(lister);
        registry.requestDelist(id);
    }
}

contract StagingConfigTest is BaseTest {
    function test_staging_goLiveInMinutes_eventCannot() public {
        // Event config: shadow bound ≥ 24h is hard-coded.
        vm.prank(admin);
        vm.expectRevert();
        config.set("SHADOW_SEC", 60);
        assertFalse(config.staging());

        ProtocolConfig staging = new ProtocolConfig(address(manager), true);
        assertTrue(staging.staging());
        assertEq(staging.get("SHADOW_SEC"), 10 minutes);
        assertEq(staging.get("MIN_HISTORY_HOURS"), 0);
    }
}
