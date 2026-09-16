// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWireBoxO {
    function initialize(string calldata handle) external;
}

/// @title Wire Office
/// The address book. Every X handle has one delivery box on Robinhood Chain and its address is derived from the handle
/// alone, so it can be read off this contract before anything is deployed. Point a Pons coin's creator fee at that
/// address and the money starts arriving; deploy the box whenever it is time to collect.
///
/// The office does not launch coins, does not touch a box's money and cannot redirect a fee stream. The guardian can
/// only rotate the oracle that reads handle proofs, and only after a public 48 hour notice.
contract WireOffice {
    uint256 public constant ORACLE_DELAY = 48 hours;

    address public immutable boxImpl;
    bytes32 public immutable cloneHash;
    address public guardian;
    address public pendingGuardian;
    address public oracle;
    address public nextOracle;
    uint64 public nextOracleAt;
    address public burner;

    mapping(bytes32 => address) public boxOf;
    string[] internal _handles;

    event BoxOpened(bytes32 indexed handleHash, address indexed box, string handle, address by);
    event OracleProposed(address oracle, uint64 activeAt);
    event OracleSet(address oracle);
    event GuardianTransferred(address indexed previous, address indexed next);

    modifier onlyGuardian() {
        require(msg.sender == guardian, "guardian");
        _;
    }

    constructor(address _boxImpl, address _oracle, address _burner) {
        require(_boxImpl != address(0) && _oracle != address(0) && _burner != address(0), "zero");
        boxImpl = _boxImpl;
        oracle = _oracle;
        burner = _burner;
        guardian = msg.sender;
        cloneHash = keccak256(_initCode(_boxImpl));
    }

    /// Lowercase X handle, 1 to 15 characters of a-z, 0-9 and underscore.
    function validHandle(string memory handle) public pure returns (bool) {
        bytes memory b = bytes(handle);
        if (b.length == 0 || b.length > 15) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) return false;
        }
        return true;
    }

    /// The delivery address of a handle, whether or not its box has been deployed yet. This is the address a coin
    /// names as its Pons creator fee recipient.
    function addressFor(string memory handle) public view returns (address) {
        require(validHandle(handle), "handle");
        bytes32 salt = keccak256(bytes(handle));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, cloneHash)))));
    }

    /// Deploys the box of a handle at that same address. Anyone can call it, it costs only gas, and it changes
    /// nothing about where the money was already going.
    function open(string calldata handle) external returns (address box) {
        require(validHandle(handle), "handle");
        bytes32 h = keccak256(bytes(handle));
        box = boxOf[h];
        if (box != address(0)) return box;
        bytes memory code = _initCode(boxImpl);
        assembly ("memory-safe") {
            box := create2(0, add(code, 0x20), mload(code), h)
        }
        require(box != address(0), "create2");
        IWireBoxO(box).initialize(handle);
        boxOf[h] = box;
        _handles.push(handle);
        emit BoxOpened(h, box, handle, msg.sender);
    }

    function isOpen(string calldata handle) external view returns (bool) {
        return boxOf[keccak256(bytes(handle))] != address(0);
    }

    function boxFor(string calldata handle) external view returns (address) {
        return boxOf[keccak256(bytes(handle))];
    }

    function handleCount() external view returns (uint256) {
        return _handles.length;
    }

    function handles(uint256 from, uint256 count) external view returns (string[] memory names, address[] memory boxes) {
        uint256 n = _handles.length;
        if (from >= n) return (new string[](0), new address[](0));
        uint256 end = from + count > n ? n : from + count;
        names = new string[](end - from);
        boxes = new address[](end - from);
        for (uint256 i = from; i < end; i++) {
            names[i - from] = _handles[i];
            boxes[i - from] = boxOf[keccak256(bytes(_handles[i]))];
        }
    }

    // ---------------------------------------------------------------- guardian

    /// A new oracle only takes effect after a public 48 hour notice, and anyone may activate it once the wait is over.
    function proposeOracle(address next) external onlyGuardian {
        require(next != address(0), "zero");
        nextOracle = next;
        nextOracleAt = uint64(block.timestamp + ORACLE_DELAY);
        emit OracleProposed(next, nextOracleAt);
    }

    function activateOracle() external {
        require(nextOracle != address(0) && block.timestamp >= nextOracleAt, "wait");
        oracle = nextOracle;
        nextOracle = address(0);
        nextOracleAt = 0;
        emit OracleSet(oracle);
    }

    function transferGuardian(address next) external onlyGuardian {
        pendingGuardian = next;
    }

    function acceptGuardian() external {
        require(msg.sender == pendingGuardian, "pending");
        emit GuardianTransferred(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    function _initCode(address impl) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            impl,
            hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
