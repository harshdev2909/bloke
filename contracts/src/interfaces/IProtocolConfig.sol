// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IProtocolConfig {
    function get(bytes32 key) external view returns (uint256);
    function getAddress(bytes32 key) external view returns (address);
}
