// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BlokeRaise} from "../src/raise/BlokeRaise.sol";
import {BlokeRegistry} from "../src/registry/BlokeRegistry.sol";

/// @notice Adds BlokeRaise (amendment A18) to an existing deployment and records it in the
/// addresses file. Env: PRIVATE_KEY, ADDRESSES (path to the deployments JSON).
contract DeployRaise is Script {
    function run() external returns (BlokeRaise raise) {
        string memory path = vm.envString("ADDRESSES");
        string memory json = vm.readFile(path);
        address manager = vm.parseJsonAddress(json, ".accessManager");
        address usdc = vm.parseJsonAddress(json, ".tusdc");
        address registry = vm.parseJsonAddress(json, ".registry");
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        raise = new BlokeRaise(manager, IERC20(usdc), BlokeRegistry(registry));
        vm.stopBroadcast();
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.writeJson(vm.toString(address(raise)), path, ".raise");
            console2.log("raise", address(raise));
        }
    }
}
