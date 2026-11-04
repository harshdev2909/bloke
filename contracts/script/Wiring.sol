// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {ProtocolConfig} from "../src/config/ProtocolConfig.sol";
import {Roles} from "../src/config/Roles.sol";
import {TestUSDC} from "../src/token/TestUSDC.sol";
import {HumanIndexOracle} from "../src/oracle/HumanIndexOracle.sol";
import {BlokeRegistry} from "../src/registry/BlokeRegistry.sol";
import {MarketEngine} from "../src/engine/MarketEngine.sol";
import {SimplePool} from "../src/pool/SimplePool.sol";
import {BlokePool} from "../src/pool/BlokePool.sol";
import {IRegistryHooks} from "../src/interfaces/IBlokeRegistry.sol";
import {LPLocker} from "../src/graduation/LPLocker.sol";
import {VestingStream} from "../src/graduation/VestingStream.sol";
import {MerkleDistributor} from "../src/graduation/MerkleDistributor.sol";
import {RepRoots} from "../src/graduation/RepRoots.sol";

/// @notice Role and selector wiring shared by the deploy script and tests (PRD §20.3 step 7).
/// Must be called by an account holding the AccessManager ADMIN role.
library Wiring {
    function wireP0(
        AccessManager m,
        ProtocolConfig config,
        TestUSDC usdc,
        HumanIndexOracle oracle,
        BlokeRegistry registry,
        address guardian,
        address lister
    ) internal {
        m.grantRole(Roles.GUARDIAN, guardian, 0);
        m.grantRole(Roles.LISTER, lister, 0);
        m.grantRole(Roles.REGISTRY, address(registry), 0);

        // ProtocolConfig: set / setAddress / addConsumer stay ADMIN (role 0 is the default for every selector).
        // The oracle caches its parameters and is re-synced on every config change.
        config.addConsumer(address(oracle));

        // tUSDC
        _one(m, address(usdc), TestUSDC.pauseFaucet.selector, Roles.GUARDIAN);
        // mint / unpauseFaucet stay ADMIN

        // Oracle
        _one(m, address(oracle), HumanIndexOracle.pause.selector, Roles.GUARDIAN);
        _one(m, address(oracle), HumanIndexOracle.setTracked.selector, Roles.REGISTRY);

        // Registry
        bytes4[] memory listerSel = new bytes4[](3);
        listerSel[0] = BlokeRegistry.list.selector;
        listerSel[1] = BlokeRegistry.goLive.selector;
        listerSel[2] = BlokeRegistry.requestDelist.selector;
        m.setTargetFunctionRole(address(registry), listerSel, Roles.LISTER);

        bytes4[] memory guardianSel = new bytes4[](3);
        guardianSel[0] = BlokeRegistry.flag.selector;
        guardianSel[1] = BlokeRegistry.clearFlag.selector;
        guardianSel[2] = BlokeRegistry.freezeClaim.selector;
        m.setTargetFunctionRole(address(registry), guardianSel, Roles.GUARDIAN);

        _one(m, address(registry), BlokeRegistry.creditCreator.selector, Roles.ENGINE);
        _one(m, address(registry), BlokeRegistry.takeCreatorBalanceForGraduation.selector, Roles.LAUNCHER);
        // unfreezeClaim, approveDelist, rejectDelist, setEngine stay ADMIN
    }

    /// @notice P1: engine, pool and the cross-contract permissions between them.
    function wireP1(AccessManager m, ProtocolConfig config, BlokeRegistry registry, MarketEngine engine, SimplePool pool)
        internal
    {
        m.grantRole(Roles.ENGINE, address(engine), 0);
        config.addConsumer(address(engine));
        registry.setEngine(IRegistryHooks(address(engine)));
        pool.setEngine(address(engine));

        bytes4[] memory guardianSel = new bytes4[](2);
        guardianSel[0] = MarketEngine.freeze.selector;
        guardianSel[1] = MarketEngine.enableGlobalReduceOnly.selector;
        m.setTargetFunctionRole(address(engine), guardianSel, Roles.GUARDIAN);
        // setStatus, disableGlobalReduceOnly stay ADMIN; pool.setEngine is ADMIN
    }

    /// @notice P2: the waterfall pool replaces SimplePool. It may switch the engine to reduce-only when a
    /// stop condition fires (PRD §8.3 step 5); the guardian keeps that power too. Clearing stays ADMIN.
    function wireP2(AccessManager m, ProtocolConfig config, BlokeRegistry registry, MarketEngine engine, BlokePool pool, address guardian)
        internal
    {
        m.grantRole(Roles.ENGINE, address(engine), 0);
        m.grantRole(Roles.POOL, address(pool), 0);
        m.grantRole(Roles.POOL, guardian, 0);
        config.addConsumer(address(engine));
        registry.setEngine(IRegistryHooks(address(engine)));
        pool.setEngine(address(engine));
        _one(m, address(engine), MarketEngine.freeze.selector, Roles.GUARDIAN);
        _one(m, address(engine), MarketEngine.enableGlobalReduceOnly.selector, Roles.POOL);
    }

    /// @notice P4: the launcher may take creator balances (mapped in wireP0) and record locks,
    /// streams and distributions; Rep roots are posted by REP_PUBLISHER.
    function wireP4(
        AccessManager m,
        address launcher,
        LPLocker locker,
        VestingStream vesting,
        MerkleDistributor distributor,
        RepRoots repRoots,
        address repPublisher
    ) internal {
        m.grantRole(Roles.LAUNCHER, launcher, 0);
        m.grantRole(Roles.REP_PUBLISHER, repPublisher, 0);
        _one(m, address(locker), LPLocker.lock.selector, Roles.LAUNCHER);
        _one(m, address(vesting), VestingStream.create.selector, Roles.LAUNCHER);
        _one(m, address(distributor), MerkleDistributor.create.selector, Roles.LAUNCHER);
        _one(m, address(repRoots), RepRoots.post.selector, Roles.REP_PUBLISHER);
    }

    function _one(AccessManager m, address target, bytes4 sel, uint64 role) private {
        bytes4[] memory s = new bytes4[](1);
        s[0] = sel;
        m.setTargetFunctionRole(target, s, role);
    }
}
