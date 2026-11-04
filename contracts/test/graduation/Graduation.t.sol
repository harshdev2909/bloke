// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketEngine} from "../../src/engine/MarketEngine.sol";
import {BlokePool} from "../../src/pool/BlokePool.sol";
import {IBlokePool} from "../../src/interfaces/IBlokePool.sol";
import {IBlokeRegistry} from "../../src/interfaces/IBlokeRegistry.sol";
import {IProtocolConfig} from "../../src/interfaces/IProtocolConfig.sol";
import {Keys} from "../../src/config/Keys.sol";
import {Wiring} from "../../script/Wiring.sol";
import {BlokeV2Factory} from "../../src/amm/BlokeV2Factory.sol";
import {BlokeV2Pair} from "../../src/amm/BlokeV2Pair.sol";
import {BlokeV2Router} from "../../src/amm/BlokeV2Router.sol";
import {TBloke} from "../../src/graduation/TBloke.sol";
import {BlokeDesk} from "../../src/graduation/BlokeDesk.sol";
import {BlokeToken} from "../../src/graduation/BlokeToken.sol";
import {LPLocker} from "../../src/graduation/LPLocker.sol";
import {VestingStream} from "../../src/graduation/VestingStream.sol";
import {MerkleDistributor} from "../../src/graduation/MerkleDistributor.sol";
import {RepRoots} from "../../src/graduation/RepRoots.sol";
import {GraduationLauncher} from "../../src/graduation/GraduationLauncher.sol";

contract GraduationTest is BaseTest {
    MarketEngine internal engine;
    BlokePool internal pool;
    TBloke internal tbloke;
    BlokeDesk internal desk;
    BlokeV2Factory internal factory;
    BlokeV2Router internal router;
    LPLocker internal locker;
    VestingStream internal vesting;
    MerkleDistributor internal distributor;
    RepRoots internal repRoots;
    GraduationLauncher internal launcher;

    address internal treasury = makeAddr("treasury");
    address internal person = makeAddr("person");
    address internal edgeLp = makeAddr("edgeLp");
    uint32 internal id;
    uint32 constant V100 = 1_000_000;

    function setUp() public override {
        super.setUp();
        pool = new BlokePool(address(manager), IERC20(address(usdc)), IProtocolConfig(address(config)), registry);
        engine = new MarketEngine(address(manager), IProtocolConfig(address(config)), oracle, registry, IBlokePool(address(pool)), IERC20(address(usdc)));
        tbloke = new TBloke(treasury);
        desk = new BlokeDesk(address(manager), IERC20(address(usdc)), IERC20(address(tbloke)), 40_000); // 0.04 tUSDC
        factory = new BlokeV2Factory();
        router = new BlokeV2Router(factory);
        locker = new LPLocker(address(manager));
        vesting = new VestingStream(address(manager));
        distributor = new MerkleDistributor(address(manager));
        repRoots = new RepRoots(address(manager));
        launcher = new GraduationLauncher(
            address(manager),
            GraduationLauncher.Deps(
                IProtocolConfig(address(config)), oracle, registry, engine, pool, IERC20(address(usdc)), IERC20(address(tbloke)), desk, factory, locker, vesting, distributor
            )
        );

        vm.startPrank(admin);
        Wiring.wireP2(manager, config, registry, engine, pool, guardian);
        Wiring.wireP4(manager, address(launcher), locker, vesting, distributor, repRoots, admin);
        config.setAddress(Keys.TREASURY, treasury);
        // A fast profile within the production bounds: 3-day averages, 1-day OI and Skin windows.
        config.set(Keys.GRAD_AVG_DAYS, 3);
        config.set(Keys.GRAD_MIN_HCS, 1_100_000);
        config.set(Keys.GRAD_OI_DAYS, 1);
        config.set(Keys.GRAD_MIN_OI_USDC, 1_000e6);
        config.set(Keys.GRAD_MIN_TRADERS, 10);
        config.set(Keys.GRAD_SKIN_DAYS, 1);
        usdc.mint(edgeLp, 2_000_000e6);
        usdc.mint(person, 10_000e6);
        usdc.mint(alice, 100_000e6);
        usdc.mint(treasury, 10_000e6);
        vm.stopPrank();

        // Desk inventory, and the treasury's allowance for graduation fees.
        vm.startPrank(treasury);
        tbloke.transfer(address(desk), 500_000_000 ether);
        usdc.approve(address(launcher), type(uint256).max);
        vm.stopPrank();

        id = _list("ALICE");
        _push1(id, V100, V100, V100);
        _warmHours(id, 72, V100);
        vm.prank(lister);
        registry.goLive(id);

        vm.prank(edgeLp);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(edgeLp);
        pool.requestDeposit(1_000_000e6);
        pool.crankEpoch();
        vm.prank(edgeLp);
        pool.claimDeposit(0);
        vm.prank(alice);
        usdc.approve(address(engine), type(uint256).max);
        vm.prank(person);
        usdc.approve(address(pool), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _converge(uint32 b, uint32 h, uint32 w) internal {
        for (uint256 i; i < 400; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _push1(id, b, h, w);
            if (oracle.latest(id).b == b && oracle.latest(id).h == h && oracle.latest(id).w == w) return;
        }
        revert("no converge");
    }

    /// Everything but the attestation: claimed with a verified source, Skin posted, an open lot for
    /// OI, a creator balance, and three days of HCS 1.15 with WORK above HYPE.
    function _qualify() internal {
        _claimAndVerify();
        vm.prank(person);
        pool.postSkin(id, 1_000e6);
        // Creator fees as the engine would credit them: the balance and the tUSDC behind it.
        registry.creditCreator(id, 500e6);
        vm.prank(admin);
        usdc.mint(address(registry), 500e6);

        // An open long so the markets carry gross OI.
        uint32 mB = engine.marketIdOf(id, 0);
        vm.prank(alice);
        uint64 o = engine.requestOpen(mB, 1, 5_000e6, 300, 0);
        vm.warp(vm.getBlockTimestamp() + 1);
        _push1(id, V100, V100, V100);
        uint64[] memory ids = new uint64[](1);
        ids[0] = o;
        engine.settle(ids);

        uint32[] memory bs = new uint32[](1);
        bs[0] = id;
        launcher.snapshotOi(bs);
        _converge(1_150_000, 1_100_000, 1_200_000);
        for (uint256 d; d < 3; ++d) _warmHoursAt(24, 1_150_000, 1_100_000, 1_200_000);
    }

    function _warmHoursAt(uint256 hours_, uint32 b, uint32 h, uint32 w) internal {
        for (uint256 i; i < hours_; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _push1(id, b, h, w);
        }
    }

    function _claimAndVerify() internal {
        uint64 expiry = uint64(vm.getBlockTimestamp() + 5 minutes);
        bytes32 dom = _domainSeparator("BLOKE Registry", address(registry));
        // Signatures first: vm.prank applies to the next call, which would otherwise be the typehash read.
        bytes memory claimSig = _sign712(dom, keccak256(abi.encode(registry.CLAIM_TYPEHASH(), id, person, uint256(1), expiry)), attesterPk);
        vm.prank(person);
        registry.claim(id, 1, expiry, claimSig);
        address[] memory linked = new address[](0);
        bytes32 sh = keccak256(abi.encode(registry.SOURCES_TYPEHASH(), id, uint8(1), keccak256(abi.encodePacked(linked)), uint256(2), expiry));
        bytes memory srcSig = _sign712(dom, sh, attesterPk);
        vm.prank(person);
        registry.setSourceVerification(id, 1, linked, 2, expiry, srcSig);
    }

    function _attest(uint32 traders, bytes32 airdropRoot, bytes32 backerRoot, uint256 nonce)
        internal
        view
        returns (GraduationLauncher.GradAttestation memory a, bytes memory sig)
    {
        a = GraduationLauncher.GradAttestation(
            id, traders, airdropRoot, launcher.AIRDROP(), backerRoot, launcher.BACKERS(), nonce, uint64(vm.getBlockTimestamp() + 5 minutes)
        );
        bytes32 sh = keccak256(
            abi.encode(launcher.GRAD_TYPEHASH(), a.blokeId, a.traderCount, a.airdropRoot, a.airdropTotal, a.backerRoot, a.backerTotal, a.nonce, a.expiry)
        );
        sig = _sign712(_domainSeparator("BLOKE Graduation", address(launcher)), sh, attesterPk);
    }

    /// Two-leaf tree: (account, amount) pairs, sorted-pair hashing like OpenZeppelin MerkleProof.
    function _tree2(address a1, uint256 v1, address a2, uint256 v2) internal view returns (bytes32 root, bytes32 l1, bytes32 l2) {
        l1 = distributor.leaf(a1, v1);
        l2 = distributor.leaf(a2, v2);
        root = l1 < l2 ? keccak256(abi.encodePacked(l1, l2)) : keccak256(abi.encodePacked(l2, l1));
    }

    // ------------------------------------------------------------ tests

    function test_checksReportEachCondition() public {
        (bool[8] memory pass,,) = launcher.checks(id, 0);
        assertFalse(pass[0], "unclaimed");
        assertFalse(pass[1], "no verified source");
        assertTrue(pass[7], "no flag, not graduated");
        _qualify();
        (pass,,) = launcher.checks(id, 0);
        for (uint256 i; i < 8; ++i) {
            if (i == 5) assertFalse(pass[i], "traders need the attestation");
            else assertTrue(pass[i], string.concat("check ", vm.toString(i + 1)));
        }
        (pass,,) = launcher.checks(id, 10);
        assertTrue(pass[5]);
    }

    function test_graduate_endToEnd() public {
        _qualify();
        (bytes32 airdropRoot, bytes32 leafAlice, bytes32 leafBob) = _tree2(alice, 150_000_000 ether, bob, 50_000_000 ether);
        (GraduationLauncher.GradAttestation memory a, bytes memory sig) = _attest(12, airdropRoot, distributor.leaf(edgeLp, 100_000_000 ether), 7);
        address predicted = launcher.predictToken(id);
        uint256 creator = registry.creatorBalance(id);

        vm.prank(person);
        uint256 g0 = gasleft();
        (address token, address pair) = launcher.graduate(a, sig);
        uint256 used = g0 - gasleft();
        assertLt(used, 8_000_000, "graduate under the 8M gas target");
        emit log_named_uint("graduate gas", used);

        assertEq(token, predicted, "CREATE2 address is predictable");
        assertEq(uint256(registry.status(id)), uint256(IBlokeRegistry.Status.Graduated));
        BlokeToken t = BlokeToken(token);
        assertEq(t.symbol(), "ALICE");
        assertTrue(t.transfersEnabled());
        assertEq(t.balanceOf(address(launcher)), 0);
        assertEq(t.balanceOf(pair), 500_000_000 ether);
        assertEq(t.balanceOf(address(distributor)), 300_000_000 ether);
        assertEq(t.balanceOf(address(vesting)), 150_000_000 ether);
        assertEq(t.balanceOf(treasury), 50_000_000 ether);
        // tBLOKE side: (creator + 2,000 fee) tUSDC at 0.04
        uint256 seed = creator + config.get(Keys.GRAD_FEE_USDC);
        assertEq(tbloke.balanceOf(pair), (seed * 1e18) / 40_000);
        assertGt(BlokeV2Pair(pair).balanceOf(address(locker)), 0, "LP locked");

        // Airdrop claims with a one-node proof.
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafBob;
        distributor.claim(0, alice, 150_000_000 ether, proof);
        assertEq(t.balanceOf(alice), 150_000_000 ether);
        vm.expectRevert(MerkleDistributor.AlreadyClaimed.selector);
        distributor.claim(0, alice, 150_000_000 ether, proof);
        proof[0] = leafAlice;
        distributor.claim(0, bob, 50_000_000 ether, proof);
        // Backer tree with a single leaf: empty proof.
        distributor.claim(1, edgeLp, 100_000_000 ether, new bytes32[](0));
        assertEq(t.balanceOf(edgeLp), 100_000_000 ether);

        // Vesting: nothing during the cliff, half at cliff + 182.5 days.
        vm.prank(person);
        vm.expectRevert(VestingStream.NothingToClaim.selector);
        vesting.claim(0);
        vm.warp(vm.getBlockTimestamp() + 90 days + 365 days / 2);
        vm.prank(person);
        vesting.claim(0);
        assertApproxEqRel(t.balanceOf(person), 75_000_000 ether, 1e15);

        // The pool trades once transfers are on.
        vm.startPrank(alice);
        t.approve(address(router), type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(tbloke);
        uint256[] memory outs = router.swapExactTokensForTokens(1_000_000 ether, 0, path, alice, vm.getBlockTimestamp() + 60);
        vm.stopPrank();
        assertGt(outs[1], 0);
        assertEq(tbloke.balanceOf(alice), outs[1]);

        // LP unlocks after 365 days, split by who seeded what.
        vm.expectRevert(LPLocker.Locked.selector);
        locker.release(0);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        uint256 lp = BlokeV2Pair(pair).balanceOf(address(locker));
        locker.release(0);
        assertEq(BlokeV2Pair(pair).balanceOf(person), (lp * ((creator * 10_000) / seed)) / 10_000);
        assertEq(BlokeV2Pair(pair).balanceOf(person) + BlokeV2Pair(pair).balanceOf(treasury), lp);
        vm.expectRevert(LPLocker.Released.selector);
        locker.release(0);
    }

    function test_graduate_rejections() public {
        _qualify();
        (GraduationLauncher.GradAttestation memory a, bytes memory sig) = _attest(12, bytes32(uint256(1)), bytes32(uint256(2)), 9);

        vm.prank(alice);
        vm.expectRevert(GraduationLauncher.NotClaimedWallet.selector);
        launcher.graduate(a, sig);

        (GraduationLauncher.GradAttestation memory few, bytes memory sigFew) = _attest(3, bytes32(uint256(1)), bytes32(uint256(2)), 10);
        vm.prank(person);
        vm.expectRevert(abi.encodeWithSelector(GraduationLauncher.CheckFailed.selector, uint8(6)));
        launcher.graduate(few, sigFew);

        // A separate copy (memory structs are references): the signature no longer matches.
        (GraduationLauncher.GradAttestation memory forged,) = _attest(12, bytes32(uint256(1)), bytes32(uint256(2)), 9);
        forged.traderCount = 1_000;
        vm.prank(person);
        vm.expectRevert(GraduationLauncher.BadAttestation.selector);
        launcher.graduate(forged, sig);

        vm.prank(guardian);
        registry.flag(id, 7);
        (bool[8] memory pass,,) = launcher.checks(id, 12);
        assertFalse(pass[7], "abuse flag blocks graduation");
        vm.prank(person);
        vm.expectRevert(abi.encodeWithSelector(GraduationLauncher.CheckFailed.selector, uint8(8)));
        launcher.graduate(a, sig);
        vm.prank(guardian);
        registry.clearFlag(id);

        // Someone front-runs with the pair at the token's predicted address and donates tBLOKE. Reserves
        // can't be seeded before the token exists, so the pair is still clean: graduation reuses it
        // and the donation ends up inside the locked LP.
        address predicted = launcher.predictToken(id);
        address p = factory.createPair(predicted, address(tbloke));
        vm.prank(treasury);
        tbloke.transfer(p, 1 ether);
        vm.prank(person);
        (address token, address pair) = launcher.graduate(a, sig);
        assertEq(token, predicted);
        assertEq(pair, p);
        (,,,,,,,, uint256 seedT) = launcher.graduations(id);
        assertEq(tbloke.balanceOf(pair), seedT + 1 ether);

        vm.prank(person);
        vm.expectRevert(GraduationLauncher.NonceUsed.selector);
        launcher.graduate(a, sig);
    }

    function test_tokenIsLockedUntilGraduationEnds() public {
        vm.prank(address(launcher));
        BlokeToken t = new BlokeToken("BLOKE: X", "X", 9);
        // Deployed by the launcher address: only it can move tokens before enableTransfers.
        vm.prank(address(launcher));
        t.transfer(alice, 10 ether);
        vm.prank(alice);
        vm.expectRevert(BlokeToken.TransfersDisabled.selector);
        t.transfer(bob, 1 ether);
        vm.prank(alice);
        vm.expectRevert(BlokeToken.OnlyLauncher.selector);
        t.enableTransfers();
    }

    function test_deskAndRepRoots() public {
        vm.prank(alice);
        usdc.approve(address(desk), type(uint256).max);
        vm.prank(alice);
        uint256 out = desk.buy(40e6, 0);
        assertEq(out, 1_000 ether, "40 tUSDC buys 1,000 tBLOKE at 0.04");
        vm.prank(alice);
        tbloke.approve(address(desk), type(uint256).max);
        vm.prank(alice);
        assertEq(desk.sell(500 ether, 0), 20e6);
        vm.prank(alice);
        vm.expectRevert();
        desk.setPrice(1);

        vm.prank(admin);
        repRoots.post(1, keccak256("table"), "ipfs://season-1");
        vm.prank(admin);
        vm.expectRevert(RepRoots.AlreadyPosted.selector);
        repRoots.post(1, keccak256("again"), "");
    }
}
