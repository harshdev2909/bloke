// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A graduated Bloke's token (PRD §10.2): 1,000,000,000 (18 dp) minted to the launcher, which
/// is the only sender allowed until it enables transfers, one way and permanently, at the end of the
/// graduate transaction. No cash-flow rights, no owner, no mint after construction (A12).
contract BlokeToken is ERC20 {
    uint256 public constant SUPPLY = 1_000_000_000 ether;

    address public immutable launcher;
    uint32 public immutable blokeId;
    bool public transfersEnabled;

    error TransfersDisabled();
    error OnlyLauncher();

    event TransfersEnabled();

    constructor(string memory name_, string memory symbol_, uint32 blokeId_) ERC20(name_, symbol_) {
        launcher = msg.sender;
        blokeId = blokeId_;
        _mint(msg.sender, SUPPLY);
    }

    function enableTransfers() external {
        if (msg.sender != launcher) revert OnlyLauncher();
        transfersEnabled = true;
        emit TransfersEnabled();
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!transfersEnabled && from != launcher && from != address(0)) revert TransfersDisabled();
        super._update(from, to, value);
    }
}
