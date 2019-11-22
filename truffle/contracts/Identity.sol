pragma solidity ^0.5.0;

contract Identity {
    mapping(string => address) identityToOwner;
    mapping(address => bool) ownersExist;
    mapping(string => mapping(string => string)) ikv;
    // At the same time this mapping is used to see if the identity is registered at all
    mapping(string => string) lowercaseToCanonicalIdentities;

    uint public MAX_HANDLE_LENGTH = 16;

    event IdentityRegistered(string handle, address identityOwner);
    event IKVSet(string identity, string key, string value);

    function register(string memory handle, address identityOwner) public {
        if (!_isValidHandle(handle)) revert('Only alphanumeric characters and an underscore allowed');

        // Check if the identity is already registered
        string memory lowercase = _toLower(handle);
        if (!_isEmptyString(lowercaseToCanonicalIdentities[lowercase])) revert('This identity has already been registered');

        // Check if this owner already has an identity attached
        if (ownersExist[identityOwner]) revert('This owner already has an identity attached');

        // Attach this identity to the owner address
        identityToOwner[handle] = identityOwner;
        ownersExist[identityOwner] = true;

        // Add canonical version
        lowercaseToCanonicalIdentities[lowercase] = handle;

        emit IdentityRegistered(handle, identityOwner);
    }

    modifier onlyIdentityOwner(string memory identity) {
        if (msg.sender != identityToOwner[identity]) revert('You are not the owner of this identity'); // todo: identityToOwner[identity] == address(0) ?
        _;
    }

    // In the prototype, we don't check who owns the domain
    function ikvPut(string memory identity, string memory key, string memory value) public onlyIdentityOwner(identity) {
        ikv[identity][key] = value;

        emit IKVSet(identity, key, value);
    }

    function ikvGet(string memory identity, string memory key) public view returns (string memory value) {
        return ikv[identity][key];
    }

    //*** Internal functions ***//

    function _isValidHandle(string memory str) internal view returns (bool) {
        bytes memory b = bytes(str);
        if(b.length > MAX_HANDLE_LENGTH) return false;

        for(uint i; i<b.length; i++){
            bytes1 char = b[i];

            if(
                !(char >= bytes1(uint8(0x30)) && char <= bytes1(uint8(0x39))) && // 9-0
                !(char >= bytes1(uint8(0x41)) && char <= bytes1(uint8(0x5A))) && // A-Z
                !(char >= bytes1(uint8(0x61)) && char <= bytes1(uint8(0x7A))) && // a-z
                !(char == bytes1(uint8(0x95))) // _
            )
            return false;
        }

        return true;
    }

    function _toLower(string memory str) internal pure returns (string memory) {
        bytes memory bStr = bytes(str);
        bytes memory bLower = new bytes(bStr.length);
        for (uint i = 0; i < bStr.length; i++) {
            // Is it an uppercase alphabetic character?
            if ((bStr[i] >= bytes1(uint8(65))) && (bStr[i] <= bytes1(uint8(90)))) {
                // Yes, add 32 to make it lowercase
                bLower[i] = bytes1(uint8(uint(uint8(bStr[i])) + 32));
            } else {
                // No
                bLower[i] = bStr[i];
            }
        }
        return string(bLower);
    }

    function _isEmptyString(string memory str) public pure returns (bool result) {
        return (bytes(str).length == 0);
    }
}