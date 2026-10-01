// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "src/rayls-protocol-sdk/tokens/RaylsErc20Handler.sol";
import "src/rayls-node/rayls-public-chain/tokens/PublicChainERC20.sol";
import "src/privateHub/AccessControl/RaylsAccessManagerV1.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IRaylsAccessManager} from "src/privateHub/AccessControl/interfaces/IRaylsAccessManager.sol";

// Test doubles, not Rayls endpoints, registries, or production role configuration.
contract LabRegistry {
    bool public active = true;
    function setActive(bool a) external { active = a; }
    function isTokenActiveForPublicChain(address) external view returns (bool) { return active; }
    function getPrivacyNodeStatus(address) external pure returns (uint8) { return 2; }
    function getPublicChainStatus(address) external view returns (uint8) { return active ? 2 : 0; }
}
contract LabGovernance {
    mapping(address => bool) public approved;
    function approve(address a) external { approved[a] = true; }
    function checkUserIsApprovedByPrivateAddress(address a) external view returns (bool) { return approved[a]; }
}
contract LabEndpoint {
    address public immutable authority;
    address public immutable registry;
    bytes public lastPayload;
    bytes public lastRevert;
    uint256 public nonce;
    event LabMessage(bytes32 id, address caller, uint256 destinationChainId, address destination, bytes payload, bytes revertPayload);
    constructor(address a, address r) { authority = a; registry = r; }
    function getAddressByResourceId(bytes32) external view returns (address) { return registry; }
    function getChainId() external pure returns (uint256) { return 1001; }
    function sendToAddress(uint256 cid, address dest, bytes calldata payload, bytes memory rev, RaylsNodeBridgedTransferMetadata memory) external returns (bytes32 id) {
        lastPayload = payload; lastRevert = rev;
        id = keccak256(abi.encode(++nonce, msg.sender, cid, dest, payload));
        emit LabMessage(id, msg.sender, cid, dest, payload, rev);
    }
}
contract LabPrivateToken is RaylsErc20Handler {
    constructor(address e, address g, address recipient, uint256 amount)
        RaylsErc20Handler("Lab deposit", "LDEP", e, e, g, msg.sender, false) {
        _mint(recipient, amount);
    }
    // No overrides: original teleport, receive, lock, unlock and auth logic is inherited.
}
