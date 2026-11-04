// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed-price tBLOKE desk (PRD §10.4): buys and sells tBLOKE for tUSDC at `price` tUSDC (6 dp)
/// per tBLOKE, 0.04 at launch. Inventory is whatever the admin transfers in. Testnet only.
contract BlokeDesk is AccessManaged, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IERC20 public immutable tbloke;
    /// @notice tUSDC units (6 dp) per 1 tBLOKE (1e18).
    uint256 public price;

    error ZeroAmount();
    error Slippage();
    error BadPrice();

    event Bought(address indexed buyer, uint256 usdcIn, uint256 tblokeOut);
    event Sold(address indexed seller, uint256 tblokeIn, uint256 usdcOut);
    event PriceSet(uint256 price);

    constructor(address authority, IERC20 usdc_, IERC20 tbloke_, uint256 price_) AccessManaged(authority) {
        usdc = usdc_;
        tbloke = tbloke_;
        _setPrice(price_);
    }

    function quoteBuy(uint256 usdcIn) public view returns (uint256) {
        return (usdcIn * 1e18) / price;
    }

    function quoteSell(uint256 tblokeIn) public view returns (uint256) {
        return (tblokeIn * price) / 1e18;
    }

    function buy(uint256 usdcIn, uint256 minOut) external nonReentrant returns (uint256 out) {
        if (usdcIn == 0) revert ZeroAmount();
        out = quoteBuy(usdcIn);
        if (out < minOut || out == 0) revert Slippage();
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        tbloke.safeTransfer(msg.sender, out);
        emit Bought(msg.sender, usdcIn, out);
    }

    function sell(uint256 tblokeIn, uint256 minOut) external nonReentrant returns (uint256 out) {
        if (tblokeIn == 0) revert ZeroAmount();
        out = quoteSell(tblokeIn);
        if (out < minOut || out == 0) revert Slippage();
        tbloke.safeTransferFrom(msg.sender, address(this), tblokeIn);
        usdc.safeTransfer(msg.sender, out);
        emit Sold(msg.sender, tblokeIn, out);
    }

    function setPrice(uint256 price_) external restricted {
        _setPrice(price_);
    }

    function _setPrice(uint256 p) private {
        if (p == 0) revert BadPrice();
        price = p;
        emit PriceSet(p);
    }
}
