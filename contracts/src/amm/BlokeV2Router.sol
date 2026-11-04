// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BlokeV2Factory} from "./BlokeV2Factory.sol";
import {BlokeV2Pair} from "./BlokeV2Pair.sol";

/// @notice The ERC-20 subset of Uniswap V2 Router02 (PRD §10.5): add/remove liquidity, exact-in and
/// exact-out swaps along a path, and the quote helpers. No native-token or fee-on-transfer variants
/// (every BLOKE asset is a plain ERC-20 on testnet). Pairs are looked up through the factory.
contract BlokeV2Router {
    using SafeERC20 for IERC20;

    BlokeV2Factory public immutable factory;

    error Expired();
    error InsufficientAAmount();
    error InsufficientBAmount();
    error InsufficientOutputAmount();
    error ExcessiveInputAmount();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error InvalidPath();
    error NoPair();

    constructor(BlokeV2Factory factory_) {
        factory = factory_;
    }

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    // ---------------------------------------------------------------- liquidity

    function _addLiquidity(address tokenA, address tokenB, uint256 aDesired, uint256 bDesired, uint256 aMin, uint256 bMin)
        internal
        returns (uint256 a, uint256 b)
    {
        if (factory.getPair(tokenA, tokenB) == address(0)) factory.createPair(tokenA, tokenB);
        (uint256 rA, uint256 rB) = getReserves(tokenA, tokenB);
        if (rA == 0 && rB == 0) return (aDesired, bDesired);
        uint256 bOptimal = quote(aDesired, rA, rB);
        if (bOptimal <= bDesired) {
            if (bOptimal < bMin) revert InsufficientBAmount();
            return (aDesired, bOptimal);
        }
        uint256 aOptimal = quote(bDesired, rB, rA);
        if (aOptimal < aMin) revert InsufficientAAmount();
        return (aOptimal, bDesired);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = factory.getPair(tokenA, tokenB);
        IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);
        liquidity = BlokeV2Pair(pair).mint(to);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = _pair(tokenA, tokenB);
        IERC20(pair).safeTransferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = BlokeV2Pair(pair).burn(to);
        (address token0,) = sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    // ---------------------------------------------------------------- swaps

    function _swap(uint256[] memory amounts, address[] calldata path, address to) internal {
        for (uint256 i; i < path.length - 1; ++i) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = sortTokens(input, output);
            uint256 out = amounts[i + 1];
            (uint256 out0, uint256 out1) = input == token0 ? (uint256(0), out) : (out, uint256(0));
            address dest = i < path.length - 2 ? _pair(output, path[i + 2]) : to;
            BlokeV2Pair(_pair(input, output)).swap(out0, out1, dest, new bytes(0));
        }
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        amounts = getAmountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, _pair(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] calldata path, address to, uint256 deadline)
        external
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        amounts = getAmountsIn(amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        IERC20(path[0]).safeTransferFrom(msg.sender, _pair(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    // ---------------------------------------------------------------- library

    function sortTokens(address a, address b) public pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _pair(address a, address b) internal view returns (address p) {
        p = factory.getPair(a, b);
        if (p == address(0)) revert NoPair();
    }

    function getReserves(address tokenA, address tokenB) public view returns (uint256 rA, uint256 rB) {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint112 r0, uint112 r1,) = BlokeV2Pair(_pair(tokenA, tokenB)).getReserves();
        (rA, rB) = tokenA == token0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function quote(uint256 amountA, uint256 rA, uint256 rB) public pure returns (uint256) {
        if (amountA == 0) revert InsufficientAmount();
        if (rA == 0 || rB == 0) revert InsufficientLiquidity();
        return (amountA * rB) / rA;
    }

    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        if (amountIn == 0) revert InsufficientAmount();
        if (rIn == 0 || rOut == 0) revert InsufficientLiquidity();
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    function getAmountIn(uint256 amountOut, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        if (amountOut == 0) revert InsufficientAmount();
        if (rIn == 0 || rOut == 0 || amountOut >= rOut) revert InsufficientLiquidity();
        return (rIn * amountOut * 1000) / ((rOut - amountOut) * 997) + 1;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            (uint256 rIn, uint256 rOut) = getReserves(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path) public view returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; --i) {
            (uint256 rIn, uint256 rOut) = getReserves(path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], rIn, rOut);
        }
    }
}
