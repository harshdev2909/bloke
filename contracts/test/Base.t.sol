// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProtocolConfig} from "../src/config/ProtocolConfig.sol";
import {Keys} from "../src/config/Keys.sol";
import {Roles} from "../src/config/Roles.sol";
import {TestUSDC} from "../src/token/TestUSDC.sol";
import {HumanIndexOracle} from "../src/oracle/HumanIndexOracle.sol";
import {IHumanIndexOracle} from "../src/interfaces/IHumanIndexOracle.sol";
import {IProtocolConfig} from "../src/interfaces/IProtocolConfig.sol";
import {BlokeRegistry} from "../src/registry/BlokeRegistry.sol";
import {IBlokeRegistry} from "../src/interfaces/IBlokeRegistry.sol";
import {Wiring} from "../script/Wiring.sol";

abstract contract BaseTest is Test {
    AccessManager internal manager;
    ProtocolConfig internal config;
    TestUSDC internal usdc;
    HumanIndexOracle internal oracle;
    BlokeRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal lister = makeAddr("lister");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal signerPk = 0xA11CE;
    uint256 internal attesterPk = 0xB0B;
    address internal signer;
    address internal attester;

    uint64 internal seq;
    uint256 internal nonceCounter;

    function setUp() public virtual {
        vm.warp(1_800_000_000); // a realistic, hour-aligned-ish timestamp
        signer = vm.addr(signerPk);
        attester = vm.addr(attesterPk);

        manager = new AccessManager(admin);
        config = new ProtocolConfig(address(manager), false);
        usdc = new TestUSDC(address(manager), IProtocolConfig(address(config)));
        oracle = new HumanIndexOracle(address(manager), IProtocolConfig(address(config)));
        registry = new BlokeRegistry(
            address(manager), IProtocolConfig(address(config)), oracle, IERC20(address(usdc))
        );

        vm.startPrank(admin);
        Wiring.wireP0(manager, config, usdc, oracle, registry, guardian, lister);
        manager.grantRole(Roles.ENGINE, address(this), 0); // lets tests credit creator fees
        config.setAddress(Keys.ORACLE_SIGNER, signer);
        config.setAddress(Keys.ATTESTER, attester);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _list(bytes16 ticker) internal returns (uint32 id) {
        vm.prank(lister);
        id = registry.list(
            IBlokeRegistry.BlokeInit({
                ticker: ticker,
                name: "Test Bloke",
                sourceIdsHash: keccak256(abi.encode(ticker)),
                tier: 1,
                workSourceMask: 7
            })
        );
    }

    function _entry(uint32 id, uint32 b, uint32 h, uint32 w) internal pure returns (IHumanIndexOracle.IndexEntry memory) {
        return IHumanIndexOracle.IndexEntry(id, b, h, w);
    }

    function _push(IHumanIndexOracle.IndexEntry[] memory entries) internal {
        _pushAt(entries, uint64(vm.getBlockTimestamp() * 1000));
    }

    function _pushAt(IHumanIndexOracle.IndexEntry[] memory entries, uint64 tsMs) internal {
        IHumanIndexOracle.IndexPush memory p = IHumanIndexOracle.IndexPush(++seq, tsMs, bytes32("v1"), entries);
        oracle.push(p, _signPush(p, signerPk));
    }

    function _push1(uint32 id, uint32 b, uint32 h, uint32 w) internal {
        IHumanIndexOracle.IndexEntry[] memory e = new IHumanIndexOracle.IndexEntry[](1);
        e[0] = _entry(id, b, h, w);
        _push(e);
    }

    function _signPush(IHumanIndexOracle.IndexPush memory p, uint256 pk) internal view returns (bytes memory) {
        bytes32 digest = oracle.hashPush(p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator(string memory name, address verifying) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                verifying
            )
        );
    }

    function _sign712(bytes32 domain, bytes32 structHash, uint256 pk) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Advances one hour at a time, pushing a constant value each hour, so a Bloke builds checkpoints.
    function _warmHours(uint32 id, uint256 hours_, uint32 v) internal {
        for (uint256 i; i < hours_; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            _push1(id, v, v, v);
        }
    }
}
