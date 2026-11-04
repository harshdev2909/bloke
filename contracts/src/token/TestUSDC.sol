// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IProtocolConfig} from "../interfaces/IProtocolConfig.sol";
import {Keys} from "../config/Keys.sol";

/// @title TestUSDC (tUSDC)
/// @notice Valueless 6-decimal test stablecoin with an identity-gated faucet (PRD §12.2).
/// Amendment A8: `faucet` takes the recipient explicitly so a relayer can submit it, letting a
/// wallet with zero MON receive tUSDC (the relayer drips gas separately).
contract TestUSDC is ERC20, ERC20Permit, AccessManaged {
    bytes32 public constant FAUCET_TYPEHASH =
        keccak256("Faucet(bytes32 identityHash,address wallet,uint64 expiry)");
    uint256 public constant MAX_ATTESTATION_TTL = 10 minutes;

    IProtocolConfig public immutable config;
    bool public faucetPaused;
    mapping(bytes32 identityHash => uint64 lastClaimAt) public lastFaucetAt;

    event FaucetClaimed(bytes32 indexed identityHash, address indexed wallet, uint256 amount);
    event FaucetPaused(bool paused);

    error FaucetCooldown();
    error BadAttestation();
    error FaucetIsPaused();
    error Expired();

    constructor(address authority, IProtocolConfig config_)
        ERC20("BLOKE Test USDC", "tUSDC")
        ERC20Permit("BLOKE Test USDC")
        AccessManaged(authority)
    {
        config = config_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints the faucet amount to `wallet`. Callable by anyone holding a valid attestation.
    function faucet(address wallet, bytes32 identityHash, uint64 expiry, bytes calldata sig) external {
        if (faucetPaused) revert FaucetIsPaused();
        if (expiry < block.timestamp || expiry > block.timestamp + MAX_ATTESTATION_TTL) revert Expired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(FAUCET_TYPEHASH, identityHash, wallet, expiry)));
        if (ECDSA.recover(digest, sig) != config.getAddress(Keys.ATTESTER)) revert BadAttestation();

        uint64 last = lastFaucetAt[identityHash];
        if (last != 0 && block.timestamp < last + config.get(Keys.FAUCET_COOLDOWN_SEC)) revert FaucetCooldown();
        lastFaucetAt[identityHash] = uint64(block.timestamp);

        uint256 amount = config.get(Keys.FAUCET_AMOUNT_USDC);
        _mint(wallet, amount);
        emit FaucetClaimed(identityHash, wallet, amount);
    }

    /// @notice Seeding only (ADMIN).
    function mint(address to, uint256 amount) external restricted {
        _mint(to, amount);
    }

    /// @notice GUARDIAN role in the AccessManager.
    function pauseFaucet() external restricted {
        faucetPaused = true;
        emit FaucetPaused(true);
    }

    /// @notice ADMIN role in the AccessManager.
    function unpauseFaucet() external restricted {
        faucetPaused = false;
        emit FaucetPaused(false);
    }
}
