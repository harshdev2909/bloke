// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";

/// @notice Season-end Rep commitments (PRD §11.3): the Merkle root of the final Rep table and where
/// the table is published. REP_PUBLISHER only, once per season.
contract RepRoots is AccessManaged {
    struct Root {
        bytes32 root;
        uint64 postedAt;
        string uri;
    }

    mapping(uint256 => Root) public roots;

    error AlreadyPosted();
    error EmptyRoot();

    event RootPosted(uint256 indexed season, bytes32 root, string uri);

    constructor(address authority) AccessManaged(authority) {}

    function post(uint256 season, bytes32 root, string calldata uri) external restricted {
        if (root == bytes32(0)) revert EmptyRoot();
        if (roots[season].root != bytes32(0)) revert AlreadyPosted();
        roots[season] = Root(root, uint64(block.timestamp), uri);
        emit RootPosted(season, root, uri);
    }
}
