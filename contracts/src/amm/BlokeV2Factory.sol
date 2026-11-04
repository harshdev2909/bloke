// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {BlokeV2Pair} from "./BlokeV2Pair.sol";

/// @notice Uniswap V2-compatible factory (PRD §10.5). Pairs are created with CREATE2, salted by the
/// sorted token pair, so a pair's address is known before it exists. No fee switch.
contract BlokeV2Factory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 count);

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();
        pair = address(new BlokeV2Pair{salt: keccak256(abi.encodePacked(token0, token1))}());
        BlokeV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }
}
