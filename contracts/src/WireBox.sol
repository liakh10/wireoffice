// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsEscrow, IPonsCurve, IERC20W, IWETHW, IFeedW, IV3PoolW, WireAddrs} from "./WireTypes.sol";

interface IWireOfficeB {
    function oracle() external view returns (address);
    function guardian() external view returns (address);
    function burner() external view returns (address);
}

/// @title Wire Office delivery box
/// One box per X handle. Its address is derived from the handle alone, so anyone launching a coin on Pons can set it
/// as the creator fee recipient before the box even exists. The box sweeps its coins' curves, claims the Pons escrow,
/// keeps the office fee aside for the $WIRE burn and turns the rest into USDG, the dollar of Robinhood Chain.
/// The dollars wait here until the handle proves it owns itself.
///
/// Claiming: the handle publishes a public post with a code, the Wire Office oracle signs (handle, wallet, nonce,
/// deadline) and `bind` starts a 48 hour wait that the guardian or the wallet in place can cancel. After the wait
/// `confirm` sets the wallet, and every settlement from then on is wired straight to it.
contract WireBox {
    uint256 public constant OFFICE_FEE_BPS = 500;
    uint256 public constant BIND_DELAY = 48 hours;
    uint256 public constant MAX_SETTLE = 2 ether;
    uint256 public constant MIN_SETTLE = 0.0005 ether;
    uint256 public constant MAX_SLIPPAGE_BPS = 150;
    uint256 public constant MAX_FEED_AGE = 4 days;

    IWireOfficeB public office;
    bytes32 public handleHash;
    string public handle;
    address public wallet;
    address public pendingWallet;
    uint64 public pendingAt;
    uint256 public nonce;

    uint256 public totalCollected;
    uint256 public totalOfficeFee;
    uint256 public totalWired;
    uint256 public totalPaid;
    uint64 public lastWiredAt;

    bool internal initialized;
    bool internal entered;
    bool internal swapping;

    event Swept(address indexed curve, bool ok);
    event Collected(uint256 eth);
    event Wired(uint256 ethIn, uint256 usdgOut, uint256 officeFee);
    event BindStarted(address indexed wallet, uint256 nonce, uint64 readyAt);
    event BindCancelled(address indexed wallet, address indexed by);
    event WalletSet(address indexed wallet);
    event Paid(address indexed wallet, uint256 usdg);

    modifier nonReentrant() {
        require(!entered, "reentrant");
        entered = true;
        _;
        entered = false;
    }

    constructor() {
        initialized = true;
    }

    function initialize(string calldata _handle) external {
        require(!initialized, "init");
        initialized = true;
        office = IWireOfficeB(msg.sender);
        handle = _handle;
        handleHash = keccak256(bytes(_handle));
    }

    receive() external payable {}

    // ---------------------------------------------------------------- the wire

    /// Pons records the fee recipient as the deployer of the curve, and that recipient is this box, so only the box
    /// can move a coin's curve fees into the escrow. Anyone may ask it to. A curve that refuses is simply skipped.
    function sweep(address[] calldata curves) public {
        for (uint256 i = 0; i < curves.length; i++) {
            /// an address with no code would take the whole call down with it, and try/catch does not save us there
            if (curves[i].code.length == 0) { emit Swept(curves[i], false); continue; }
            try IPonsCurve(curves[i]).sweepFees(0) { emit Swept(curves[i], true); } catch { emit Swept(curves[i], false); }
        }
    }

    /// Claims whatever the Pons escrow holds for this box. Anyone can call it.
    function collect() public returns (uint256 claimed) {
        if (IPonsEscrow(WireAddrs.ESCROW).balanceOf(address(this)) == 0) return 0;
        uint256 before = address(this).balance;
        IPonsEscrow(WireAddrs.ESCROW).claim();
        claimed = address(this).balance - before;
        totalCollected += claimed;
        emit Collected(claimed);
    }

    /// Turns ETH into USDG at no worse than the Chainlink price minus 1.5%, after setting the office fee aside for
    /// the $WIRE burn. Anyone can call it. A stale feed simply means the ETH waits for the next call.
    function settle() public nonReentrant returns (uint256 usdgOut) {
        uint256 amount = address(this).balance;
        if (amount > MAX_SETTLE) amount = MAX_SETTLE;
        if (amount < MIN_SETTLE) return 0;

        (bool fresh, uint256 ethUsd) = _price();
        if (!fresh) return 0;

        uint256 fee = amount * OFFICE_FEE_BPS / 10_000;
        if (fee > 0) {
            (bool ok,) = office.burner().call{value: fee}("");
            if (ok) totalOfficeFee += fee;
            else fee = 0;
        }
        uint256 ethIn = amount - fee;
        if (ethIn < MIN_SETTLE) return 0;

        /// ethIn (1e18 wei) * ethUsd (1e8) / 1e20 == the same money counted in USDG (1e6)
        uint256 minOut = ethIn * ethUsd / 1e20 * (10_000 - MAX_SLIPPAGE_BPS) / 10_000;
        uint256 before = IERC20W(WireAddrs.USDG).balanceOf(address(this));

        IWETHW(WireAddrs.WETH).deposit{value: ethIn}();
        bool zeroForOne = IV3PoolW(WireAddrs.WETH_USDG_POOL).token0() == WireAddrs.WETH;
        swapping = true;
        IV3PoolW(WireAddrs.WETH_USDG_POOL).swap(address(this), zeroForOne, int256(ethIn), zeroForOne ? WireAddrs.MIN_SQRT : WireAddrs.MAX_SQRT, "");
        swapping = false;

        usdgOut = IERC20W(WireAddrs.USDG).balanceOf(address(this)) - before;
        require(usdgOut >= minOut, "slippage");
        totalWired += usdgOut;
        lastWiredAt = uint64(block.timestamp);
        emit Wired(ethIn, usdgOut, fee);
        if (wallet != address(0)) _pay();
    }

    /// Sweep, collect and settle in one call, the way the site's button and the keeper do it.
    function run(address[] calldata curves) external returns (uint256 claimed, uint256 usdgOut) {
        if (curves.length > 0) sweep(curves);
        claimed = collect();
        usdgOut = settle();
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        require(swapping && msg.sender == WireAddrs.WETH_USDG_POOL, "pool");
        require(IWETHW(WireAddrs.WETH).transfer(msg.sender, uint256(a0 > 0 ? a0 : a1)), "pay");
    }

    function _price() internal view returns (bool fresh, uint256 price) {
        (, int256 answer,, uint256 updatedAt,) = IFeedW(WireAddrs.ETH_USD).latestRoundData();
        fresh = answer > 0 && updatedAt + MAX_FEED_AGE >= block.timestamp;
        price = answer > 0 ? uint256(answer) : 0;
    }

    // ---------------------------------------------------------------- claiming

    /// The message the oracle signs after reading the handle's public post.
    function bindDigest(address to, uint256 bindNonce, uint256 deadline) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(keccak256("WIRE_OFFICE_BIND"), block.chainid, address(this), handleHash, to, bindNonce, deadline));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /// Starts the 48 hour wait for `to`. Anyone may submit a valid oracle signature.
    function bind(address to, uint256 deadline, bytes calldata signature) external {
        require(to != address(0) && deadline >= block.timestamp, "deadline");
        require(signature.length == 65, "signature");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "signature");
        address signer = ecrecover(bindDigest(to, nonce, deadline), v, r, s);
        require(signer != address(0) && signer == office.oracle(), "oracle");
        nonce++;
        pendingWallet = to;
        pendingAt = uint64(block.timestamp);
        emit BindStarted(to, nonce - 1, uint64(block.timestamp + BIND_DELAY));
    }

    function cancelBind() external {
        require(pendingWallet != address(0), "nothing pending");
        require(msg.sender == office.guardian() || (wallet != address(0) && msg.sender == wallet), "guardian");
        emit BindCancelled(pendingWallet, msg.sender);
        pendingWallet = address(0);
        pendingAt = 0;
    }

    function confirm() external {
        require(pendingWallet != address(0), "nothing pending");
        require(block.timestamp >= pendingAt + BIND_DELAY, "wait");
        wallet = pendingWallet;
        pendingWallet = address(0);
        pendingAt = 0;
        emit WalletSet(wallet);
    }

    /// Sends every dollar in the box to the confirmed wallet. Anyone can call it.
    function payout() external nonReentrant {
        require(wallet != address(0), "no wallet");
        _pay();
    }

    function _pay() internal {
        uint256 d = IERC20W(WireAddrs.USDG).balanceOf(address(this));
        if (d == 0) return;
        require(IERC20W(WireAddrs.USDG).transfer(wallet, d), "usdg");
        totalPaid += d;
        emit Paid(wallet, d);
    }

    // ---------------------------------------------------------------- views

    function state() external view returns (
        string memory h, address w, address pending, uint64 readyAt,
        uint256 usdg, uint256 eth, uint256 escrowed, uint256 wired, uint256 paid, uint64 lastAt
    ) {
        h = handle;
        w = wallet;
        pending = pendingWallet;
        readyAt = pendingAt == 0 ? 0 : pendingAt + uint64(BIND_DELAY);
        usdg = IERC20W(WireAddrs.USDG).balanceOf(address(this));
        eth = address(this).balance;
        escrowed = IPonsEscrow(WireAddrs.ESCROW).balanceOf(address(this));
        wired = totalWired;
        paid = totalPaid;
        lastAt = lastWiredAt;
    }
}
