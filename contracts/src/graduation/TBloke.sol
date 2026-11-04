// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice tBLOKE (PRD §10.4): the testnet quote asset for graduation pools. 1,000,000,000 minted to
/// the treasury once; no further minting. Not the production $BLOKE token.
contract TBloke is ERC20 {
    constructor(address treasury) ERC20("BLOKE Testnet", "tBLOKE") {
        _mint(treasury, 1_000_000_000 ether);
    }
}
