// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IHumanIndexOracle {
    enum Leg {
        Blend,
        Hype,
        Work
    }

    struct IndexEntry {
        uint32 blokeId;
        uint32 b;
        uint32 h;
        uint32 w;
    }

    struct IndexPush {
        uint64 seq;
        uint64 tsMs;
        bytes32 paramsVersion;
        IndexEntry[] entries;
    }

    struct LatestView {
        uint32 b;
        uint32 h;
        uint32 w;
        uint64 tsMs;
        uint8 lagFlags;
        bool fresh;
        bool tracked;
    }

    function push(IndexPush calldata p, bytes calldata sig) external;
    function lastSeq() external view returns (uint64);
    function paused() external view returns (bool);
    function latest(uint32 blokeId) external view returns (LatestView memory);
    function value(uint32 blokeId, Leg leg) external view returns (uint32 v, uint64 tsMs, bool fresh);
    function lagDirection(uint32 blokeId, Leg leg) external view returns (int8);
    function read(uint32 blokeId, Leg leg) external view returns (uint32 v, bool fresh, int8 lag, bool isPaused);
    function avg(uint32 blokeId, uint256 days_) external view returns (uint32 b, uint32 h, uint32 w, uint256 nDays);
    function twap(uint32 blokeId, Leg leg, uint256 seconds_) external view returns (uint32);
    function hasFullDay(uint32 blokeId) external view returns (bool);
    function hasHistory(uint32 blokeId, uint256 hours_) external view returns (bool);
    function setTracked(uint32 blokeId, bool tracked) external;
}
