// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Pons V2 on Robinhood Chain: the parts Wire Office calls. Addresses verified on chain 4663.
struct PonsLaunchedToken {
    address token;
    address curve;
    address deployer;
    address creatorFeeRecipient;
    address pairToken;
    uint256 graduationThreshold;
    uint24 poolFee;
    int24 tickSpacing;
    uint16 creatorTaxBps;
    bool buybackEnabled;
    uint8 phase;
    uint256 sweptQuote;
    uint256 sweptTokens;
    uint256 sweptAt;
    bool exists;
}

interface IPonsFactory {
    function getLaunchedToken(address token) external view returns (PonsLaunchedToken memory);
    function memeHook() external view returns (address);
}

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sweepFees(uint256 minBuybackTokensOut) external;
    function creatorTaxBalance() external view returns (uint256);
    function quoteFeeBalance() external view returns (uint256);
}

interface IPonsEscrow {
    function balanceOf(address) external view returns (uint256);
    function claim() external;
}

interface IERC20W {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IWETHW {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
}

interface IFeedW {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IV3PoolW {
    function token0() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}

library WireAddrs {
    address internal constant PONS = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    /// USDG, the dollar of Robinhood Chain, 6 decimals
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// Uniswap V3 WETH/USDG, fee tier 100
    address internal constant WETH_USDG_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address internal constant ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant MIN_SQRT = 4295128740;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;
}
