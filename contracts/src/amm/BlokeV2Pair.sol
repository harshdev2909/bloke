// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IBlokeV2Callee {
    function uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/// @notice Uniswap V2 pair ported to Solidity 0.8 (PRD §10.5): same constant-product math, 0.3% fee,
/// MINIMUM_LIQUIDITY burn, TWAP accumulators and flash-swap callback. The protocol fee switch is
/// omitted (always off), so `kLast` is not tracked. LP tokens are plain OpenZeppelin ERC-20s.
contract BlokeV2Pair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MINIMUM_LIQUIDITY = 1e3;
    /// @dev OpenZeppelin ERC-20 refuses mints to address(0); the locked minimum goes here instead.
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    error Forbidden();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error InsufficientInputAmount();
    error K();

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    constructor() ERC20("BLOKE V2 LP", "BLOKE-V2") {
        factory = msg.sender;
    }

    function initialize(address token0_, address token1_) external {
        if (msg.sender != factory) revert Forbidden();
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function _update(uint256 balance0, uint256 balance1, uint112 r0, uint112 r1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 ts = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 elapsed = ts - blockTimestampLast; // overflow is desired
            if (elapsed > 0 && r0 != 0 && r1 != 0) {
                // UQ112x112: (r1 << 112) / r0, accumulated with intended wrap-around.
                price0CumulativeLast += ((uint256(r1) << 112) / r0) * elapsed;
                price1CumulativeLast += ((uint256(r0) << 112) / r1) * elapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = ts;
        emit Sync(reserve0, reserve1);
    }

    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        (uint112 r0, uint112 r1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - r0;
        uint256 amount1 = balance1 - r1;
        uint256 supply = totalSupply();
        if (supply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min((amount0 * supply) / r0, (amount1 * supply) / r1);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);
        _update(balance0, balance1, r0, r1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        (uint112 r0, uint112 r1,) = getReserves();
        address t0 = token0;
        address t1 = token1;
        uint256 balance0 = IERC20(t0).balanceOf(address(this));
        uint256 balance1 = IERC20(t1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));
        uint256 supply = totalSupply();
        amount0 = (liquidity * balance0) / supply;
        amount1 = (liquidity * balance1) / supply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        IERC20(t0).safeTransfer(to, amount0);
        IERC20(t1).safeTransfer(to, amount1);
        balance0 = IERC20(t0).balanceOf(address(this));
        balance1 = IERC20(t1).balanceOf(address(this));
        _update(balance0, balance1, r0, r1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external nonReentrant {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 r0, uint112 r1,) = getReserves();
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();
        uint256 balance0;
        uint256 balance1;
        {
            address t0 = token0;
            address t1 = token1;
            if (to == t0 || to == t1) revert InvalidTo();
            if (amount0Out > 0) IERC20(t0).safeTransfer(to, amount0Out); // optimistic transfer
            if (amount1Out > 0) IERC20(t1).safeTransfer(to, amount1Out);
            if (data.length > 0) IBlokeV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20(t0).balanceOf(address(this));
            balance1 = IERC20(t1).balanceOf(address(this));
        }
        uint256 amount0In = balance0 > r0 - amount0Out ? balance0 - (r0 - amount0Out) : 0;
        uint256 amount1In = balance1 > r1 - amount1Out ? balance1 - (r1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();
        {
            uint256 adj0 = balance0 * 1000 - amount0In * 3;
            uint256 adj1 = balance1 * 1000 - amount1In * 3;
            if (adj0 * adj1 < uint256(r0) * uint256(r1) * 1e6) revert K();
        }
        _update(balance0, balance1, r0, r1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function skim(address to) external nonReentrant {
        IERC20(token0).safeTransfer(to, IERC20(token0).balanceOf(address(this)) - reserve0);
        IERC20(token1).safeTransfer(to, IERC20(token1).balanceOf(address(this)) - reserve1);
    }

    function sync() external nonReentrant {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1);
    }
}
