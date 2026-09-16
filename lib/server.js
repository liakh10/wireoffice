/* Server-side chain access for the Wire Office API. */
import { createPublicClient, http, fallback, parseAbi } from 'viem';

/* A private endpoint (QuickNode) is used only here, on the server, and only from an env var.
   It must never reach lib/chains.js: that file ships to the browser and the token would be public. */
const RPC = [process.env.ROBINHOOD_RPC, 'https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'].filter(Boolean);
export const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: RPC } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } };
export const RPCS = RPC;
export const pub = createPublicClient({ chain, transport: fallback(RPC.map(u => http(u, { timeout: 15000 }))) });

export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';

export const OFFICE_ABI = parseAbi([
  'function addressFor(string handle) view returns (address)',
  'function boxFor(string handle) view returns (address)',
  'function isOpen(string handle) view returns (bool)',
  'function oracle() view returns (address)',
  'function handleCount() view returns (uint256)',
  'function handles(uint256 from, uint256 count) view returns (string[] names, address[] boxes)',
  'function open(string handle) returns (address)'
]);
export const BOX_ABI = parseAbi([
  'function nonce() view returns (uint256)',
  'function wallet() view returns (address)',
  'function pendingWallet() view returns (address)',
  'function bindDigest(address to, uint256 bindNonce, uint256 deadline) view returns (bytes32)',
  'function sweep(address[] curves)',
  'function collect() returns (uint256)',
  'function settle() returns (uint256)',
  'function run(address[] curves) returns (uint256, uint256)',
  'function state() view returns (string,address,address,uint64,uint256,uint256,uint256,uint256,uint256,uint64)'
]);
export const PONS_ABI = parseAbi([
  'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))'
]);
export const CURVE_ABI = parseAbi([
  'function creatorTaxBalance() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)'
]);
export const ESCROW_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

export const hostOf = req => String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
export const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v || '');
export const validHandle = h => /^[a-z0-9_]{1,15}$/.test(h || '');

export async function limit(R, key, max, seconds) {
  const n = await R.incr(key);
  if (n === 1) await R.expire(key, seconds);
  return n <= max;
}
