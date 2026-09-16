// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsFactory, IPonsCurve, PonsLaunchedToken, IERC20W, WireAddrs} from "./WireTypes.sol";

struct PoolKeyW {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParamsW {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerW {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKeyW memory key, SwapParamsW memory params, bytes calldata hookData) external returns (int256);
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @title Wire Office fee burner
/// The office keeps 5% of every wire, and this is where it goes. Anyone can spend it on $WIRE: on the Pons curve
/// before graduation, in its Uniswap v4 pool after, and every token bought goes straight to the dead address.
/// At most 0.5 ETH per call with a caller-set minimum output. There is no withdraw function; $WIRE can be set once.
contract WireBurner {
    uint256 public constant MAX_BURN = 0.5 ether;

    address public owner;
    address public wire;
    uint256 public totalReceived;
    uint256 public burnedEth;
    uint256 public burnedTokens;
    bool internal entered;

    event Burned(address indexed caller, uint256 ethIn, uint256 tokens, bool onCurve);
    event WireSet(address token);

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {
        totalReceived += msg.value;
    }

    function setWire(address token) external {
        require(msg.sender == owner, "owner");
        require(wire == address(0) && token != address(0), "set");
        PonsLaunchedToken memory lt = IPonsFactory(WireAddrs.PONS).getLaunchedToken(token);
        require(lt.exists && lt.pairToken == address(0), "not a pons eth launch");
        wire = token;
        emit WireSet(token);
    }

    function burn(uint256 ethIn, uint256 minOut) external returns (uint256 spent, uint256 tokens, bool onCurve) {
        require(!entered, "reentrant");
        entered = true;
        require(wire != address(0), "wire not set");
        require(minOut > 0, "min out");
        require(ethIn > 0 && ethIn <= MAX_BURN && ethIn <= address(this).balance, "amount");
        PonsLaunchedToken memory lt = IPonsFactory(WireAddrs.PONS).getLaunchedToken(wire);
        uint256 ethBefore = address(this).balance;
        uint256 deadBefore = IERC20W(wire).balanceOf(WireAddrs.DEAD);
        onCurve = lt.phase < 2;
        if (onCurve) {
            IPonsCurve(lt.curve).buy{value: ethIn}(ethIn, minOut, WireAddrs.DEAD);
        } else {
            PoolKeyW memory key = PoolKeyW(address(0), wire, lt.poolFee, lt.tickSpacing, IPonsFactory(WireAddrs.PONS).memeHook());
            IPoolManagerW(WireAddrs.POOL_MANAGER).unlock(abi.encode(key, ethIn));
        }
        spent = ethBefore - address(this).balance;
        tokens = IERC20W(wire).balanceOf(WireAddrs.DEAD) - deadBefore;
        require(spent > 0 && spent <= ethIn && tokens >= minOut, "min out");
        burnedEth += spent;
        burnedTokens += tokens;
        emit Burned(msg.sender, spent, tokens, onCurve);
        entered = false;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == WireAddrs.POOL_MANAGER, "pool manager");
        (PoolKeyW memory key, uint256 ethIn) = abi.decode(data, (PoolKeyW, uint256));
        int256 d = IPoolManagerW(WireAddrs.POOL_MANAGER).swap(key, SwapParamsW(true, -int256(ethIn), WireAddrs.MIN_SQRT), "");
        int128 paid = int128(d >> 128);
        int128 got = int128(d);
        require(paid < 0 && uint256(uint128(-paid)) <= ethIn && got > 0, "swap");
        IPoolManagerW(WireAddrs.POOL_MANAGER).settle{value: uint256(uint128(-paid))}();
        IPoolManagerW(WireAddrs.POOL_MANAGER).take(key.currency1, WireAddrs.DEAD, uint256(uint128(got)));
        return "";
    }

    function transferOwnership(address next) external {
        require(msg.sender == owner, "owner");
        owner = next;
    }
}
