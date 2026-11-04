// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProtocolConfig} from "../src/config/ProtocolConfig.sol";
import {Keys} from "../src/config/Keys.sol";
import {TestUSDC} from "../src/token/TestUSDC.sol";
import {HumanIndexOracle} from "../src/oracle/HumanIndexOracle.sol";
import {BlokeRegistry} from "../src/registry/BlokeRegistry.sol";
import {IBlokeRegistry} from "../src/interfaces/IBlokeRegistry.sol";
import {IBlokePool} from "../src/interfaces/IBlokePool.sol";
import {IProtocolConfig} from "../src/interfaces/IProtocolConfig.sol";
import {MarketEngine} from "../src/engine/MarketEngine.sol";
import {Settler} from "../src/engine/Settler.sol";
import {BlokePool} from "../src/pool/BlokePool.sol";
import {Wiring} from "./Wiring.sol";
import {GraduationLauncher} from "../src/graduation/GraduationLauncher.sol";
import {LPLocker} from "../src/graduation/LPLocker.sol";
import {VestingStream} from "../src/graduation/VestingStream.sol";
import {MerkleDistributor} from "../src/graduation/MerkleDistributor.sol";
import {RepRoots} from "../src/graduation/RepRoots.sol";
import {BlokeDesk} from "../src/graduation/BlokeDesk.sol";
import {BlokeV2Factory} from "../src/amm/BlokeV2Factory.sol";

/// @notice P0–P4 deploy (PRD §20.3 steps 1–3, 5, 7, 8 partly, 10).
/// Env:
///   PRIVATE_KEY     deployer; temporary ADMIN, handed to ADMIN_SAFE at the end if set
///   ORACLE_SIGNER, ATTESTER   signer addresses (KMS-backed in the event environment)
///   GUARDIAN, LISTER, TREASURY  default to the deployer
///   STAGING=true    staging bounds (shadow ≥ 1 min, no history minimum); never for the event set
///   EDGE_SEED / FLOOR_SEED   Edge deposit and Floor F-01 subscription (defaults 1,000,000 / 2,000,000, A3)
///   LIST_DEMO=true  lists FOUNDER and DEMO2 (Shadow)
contract Deploy is Script {
    struct Deployed {
        AccessManager manager;
        ProtocolConfig config;
        TestUSDC usdc;
        HumanIndexOracle oracle;
        BlokeRegistry registry;
        BlokePool pool;
        MarketEngine engine;
        Settler settler;
    }

    /// Graduation set (PRD §10, P4).
    struct Grad {
        address tbloke;
        address desk;
        address factory;
        address router;
        address locker;
        address vesting;
        address distributor;
        address launcher;
        address repRoots;
        address raise;
    }

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address guardian = vm.envOr("GUARDIAN", deployer);
        address lister = vm.envOr("LISTER", deployer);
        bool staging = vm.envOr("STAGING", false);

        vm.startBroadcast(pk);
        d.manager = new AccessManager(deployer);
        d.config = new ProtocolConfig(address(d.manager), staging);
        IProtocolConfig cfg = IProtocolConfig(address(d.config));
        d.usdc = new TestUSDC(address(d.manager), cfg);
        d.oracle = new HumanIndexOracle(address(d.manager), cfg);
        d.registry = new BlokeRegistry(address(d.manager), cfg, d.oracle, IERC20(address(d.usdc)));
        // Pool and engine are created from artifacts so their creation code is not embedded in this
        // script contract (which would push the script itself past the code-size limit).
        d.pool = BlokePool(
            _create("BlokePool.sol:BlokePool", abi.encode(address(d.manager), address(d.usdc), cfg, d.registry))
        );
        d.engine = MarketEngine(
            _create(
                "MarketEngine.sol:MarketEngine",
                abi.encode(address(d.manager), cfg, d.oracle, d.registry, address(d.pool), address(d.usdc))
            )
        );
        d.settler = new Settler(d.oracle, d.engine);

        Wiring.wireP0(d.manager, d.config, d.usdc, d.oracle, d.registry, guardian, lister);
        Wiring.wireP2(d.manager, d.config, d.registry, d.engine, d.pool, guardian);
        d.config.setAddress(Keys.ORACLE_SIGNER, vm.envAddress("ORACLE_SIGNER"));
        d.config.setAddress(Keys.ATTESTER, vm.envAddress("ATTESTER"));
        d.config.setAddress(Keys.TREASURY, vm.envOr("TREASURY", deployer));

        // Seed through the real paths (PRD §20.3 step 8): Edge deposit + Floor F-01 subscription.
        // The first crank processes the deposit; F-01 starts at the next crank after its start time.
        uint256 edgeSeed = vm.envOr("EDGE_SEED", uint256(1_000_000e6));
        uint256 floorSeed = vm.envOr("FLOOR_SEED", uint256(2_000_000e6));
        d.usdc.mint(deployer, edgeSeed + floorSeed);
        d.usdc.approve(address(d.pool), edgeSeed + floorSeed);
        d.pool.requestDeposit(edgeSeed);
        d.pool.crankEpoch();
        d.pool.createSeries(1_200, uint64(block.timestamp + 120), 7 days);
        d.pool.subscribe(0, floorSeed);

        if (vm.envOr("LIST_DEMO", false) && lister == deployer) {
            d.registry.list(IBlokeRegistry.BlokeInit("FOUNDER", "Founder", keccak256("founder"), 1, 7));
            d.registry.list(IBlokeRegistry.BlokeInit("DEMO2", "Demo Builder", keccak256("demo2"), 2, 3));
        }

        Grad memory g = _deployP4(d, deployer, vm.envOr("TREASURY", deployer));

        address safe = vm.envOr("ADMIN_SAFE", address(0));
        if (safe != address(0)) {
            d.manager.grantRole(0, safe, 0);
            d.manager.renounceRole(0, deployer);
        }
        vm.stopBroadcast();

        // Only a fresh broadcast writes the address file. Simulations would write predicted addresses,
        // and a --resume re-executes from the current nonce, so its addresses are wrong too: after a
        // resume, rebuild the file with scripts/addresses-from-broadcast.sh.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("not a fresh broadcast: addresses file not written");
            return d;
        }
        string memory obj = "addresses";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "startBlock", block.number);
        vm.serializeBool(obj, "staging", staging);
        vm.serializeAddress(obj, "accessManager", address(d.manager));
        vm.serializeAddress(obj, "protocolConfig", address(d.config));
        vm.serializeAddress(obj, "tusdc", address(d.usdc));
        vm.serializeAddress(obj, "oracle", address(d.oracle));
        vm.serializeAddress(obj, "registry", address(d.registry));
        vm.serializeAddress(obj, "pool", address(d.pool));
        vm.serializeAddress(obj, "engine", address(d.engine));
        vm.serializeAddress(obj, "settler", address(d.settler));
        vm.serializeAddress(obj, "tbloke", g.tbloke);
        vm.serializeAddress(obj, "desk", g.desk);
        vm.serializeAddress(obj, "v2Factory", g.factory);
        vm.serializeAddress(obj, "v2Router", g.router);
        vm.serializeAddress(obj, "lpLocker", g.locker);
        vm.serializeAddress(obj, "vesting", g.vesting);
        vm.serializeAddress(obj, "distributor", g.distributor);
        vm.serializeAddress(obj, "repRoots", g.repRoots);
        vm.serializeAddress(obj, "raise", g.raise);
        string memory json = vm.serializeAddress(obj, "launcher", g.launcher);
        string memory name = staging ? "-staging" : "";
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), name, ".json");
        vm.writeJson(json, path);
        console2.log("addresses written to", path);
    }

    /// @dev tBLOKE to the treasury, the desk at 0.04 tUSDC, the V2 factory + router, the singletons and
    /// the launcher, wired with wireP4. When the deployer is the treasury it also stocks the desk and
    /// approves the launcher for graduation fees (PRD §10.2 step 3).
    function _deployP4(Deployed memory d, address deployer, address treasury) internal returns (Grad memory g) {
        address m = address(d.manager);
        g.tbloke = _create("TBloke.sol:TBloke", abi.encode(treasury));
        g.desk = _create("BlokeDesk.sol:BlokeDesk", abi.encode(m, address(d.usdc), g.tbloke, uint256(40_000)));
        g.factory = _create("BlokeV2Factory.sol:BlokeV2Factory", "");
        g.router = _create("BlokeV2Router.sol:BlokeV2Router", abi.encode(g.factory));
        g.locker = _create("LPLocker.sol:LPLocker", abi.encode(m));
        g.vesting = _create("VestingStream.sol:VestingStream", abi.encode(m));
        g.distributor = _create("MerkleDistributor.sol:MerkleDistributor", abi.encode(m));
        g.repRoots = _create("RepRoots.sol:RepRoots", abi.encode(m));
        g.raise = _create("BlokeRaise.sol:BlokeRaise", abi.encode(m, address(d.usdc), address(d.registry)));
        GraduationLauncher.Deps memory deps = GraduationLauncher.Deps(
            IProtocolConfig(address(d.config)),
            d.oracle,
            d.registry,
            d.engine,
            d.pool,
            IERC20(address(d.usdc)),
            IERC20(g.tbloke),
            BlokeDesk(g.desk),
            BlokeV2Factory(g.factory),
            LPLocker(g.locker),
            VestingStream(g.vesting),
            MerkleDistributor(g.distributor)
        );
        g.launcher = _create("GraduationLauncher.sol:GraduationLauncher", abi.encode(m, deps));
        Wiring.wireP4(
            d.manager, g.launcher, LPLocker(g.locker), VestingStream(g.vesting), MerkleDistributor(g.distributor), RepRoots(g.repRoots), deployer
        );
        if (treasury == deployer) {
            IERC20(g.tbloke).transfer(g.desk, 500_000_000 ether);
            d.usdc.mint(g.desk, 100_000e6); // the desk can buy tBLOKE back
            d.usdc.mint(deployer, 20_000e6); // ten graduation fees
            d.usdc.approve(g.launcher, type(uint256).max);
        }
    }

    function _create(string memory artifact, bytes memory args) internal returns (address a) {
        bytes memory code = abi.encodePacked(vm.getCode(artifact), args);
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), artifact);
    }
}
