/* Wire Office data layer: the address book, the boxes, their dollars, and every action.
   Loaded as an ES module next to wallet.js. */
import { pubs, state as wallet, send } from './wallet.js';
import { parseAbi, formatUnits } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

const valid = v => /^0x[0-9a-fA-F]{40}$/.test(v || '') ? v : null;
export const OFFICE = valid(window.WIRE_OFFICE);
export const BURNER = valid(window.WIRE_BURNER);
export const CHAIN = 4663;
export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const ZERO = '0x0000000000000000000000000000000000000000';
const pub = pubs[CHAIN];

const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const ERC20 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function balanceOf(address) view returns (uint256)']);
const PF = parseAbi(['function launchFee() view returns (uint256)', 'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const CURVE = parseAbi(['function realQuoteReserve() view returns (uint256)', 'function graduationThreshold() view returns (uint256)', 'function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)']);
const ESC = parseAbi(['function balanceOf(address) view returns (uint256)']);

let A = null;
export async function abis() {
  if (A) return A;
  const get = async n => { for (let i = 0; i < 3; i++) { try { const r = await fetch('/lib/abi/' + n + '.json?v=1'); if (r.ok) return (await r.json()).abi; } catch {} await new Promise(r => setTimeout(r, 400 * (i + 1))); } throw Error('Could not load ' + n); };
  const [O, B, R] = await Promise.all(['WireOffice', 'WireBox', 'WireBurner'].map(get));
  A = { O, B, R };
  return A;
}

export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const eth = wei => Number(wei || 0n) / 1e18;
export const usd = v => Number(v || 0n) / 1e6;
export const fmtUsd = v => v == null ? '·' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtNum = (v, d = 4) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: d });
export const cleanHandle = h => String(h || '').trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?#]/)[0].toLowerCase();
export const validHandle = h => /^[a-z0-9_]{1,15}$/.test(h);
export const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v || '');
export { formatUnits, ZERO };

export async function ethPrice() {
  const r = await pub.readContract({ address: ETH_USD, abi: FEED, functionName: 'latestRoundData' }).catch(() => null);
  return r ? Number(r[1]) / 1e8 : null;
}

/* the delivery address of a handle, whether or not its box exists */
export async function addressFor(handle) {
  if (!OFFICE) return null;
  const { O } = await abis();
  return pub.readContract({ address: OFFICE, abi: O, functionName: 'addressFor', args: [handle] });
}

export async function isOpen(handle) {
  if (!OFFICE) return false;
  const { O } = await abis();
  return pub.readContract({ address: OFFICE, abi: O, functionName: 'isOpen', args: [handle] });
}

export async function boxState(box) {
  const { B } = await abis();
  const s = await pub.readContract({ address: box, abi: B, functionName: 'state' });
  return { handle: s[0], wallet: s[1], pending: s[2], readyAt: Number(s[3] || 0n), usdg: s[4], eth: s[5], escrowed: s[6], wired: s[7], paid: s[8], lastAt: Number(s[9] || 0n) };
}

/* every handle the office has a box for, richest first */
export async function loadAll() {
  if (!OFFICE) return { boxes: [] };
  const { O, B } = await abis();
  const n = Number(await pub.readContract({ address: OFFICE, abi: O, functionName: 'handleCount' }));
  if (!n) return { boxes: [] };
  let names = [], addrs = [];
  for (let i = 0; i < n; i += 200) {
    const [ns, as] = await pub.readContract({ address: OFFICE, abi: O, functionName: 'handles', args: [BigInt(i), 200n] });
    names = names.concat(ns); addrs = addrs.concat(as);
  }
  const res = await pub.multicall({ allowFailure: true, contracts: addrs.map(a => ({ address: a, abi: B, functionName: 'state' })) });
  const boxes = addrs.map((box, i) => {
    const s = res[i].result;
    if (!s) return { box, handle: names[i], usdg: 0n, eth: 0n, escrowed: 0n, wired: 0n, paid: 0n, wallet: ZERO, pending: ZERO, readyAt: 0, lastAt: 0 };
    return { box, handle: s[0] || names[i], wallet: s[1], pending: s[2], readyAt: Number(s[3] || 0n), usdg: s[4], eth: s[5], escrowed: s[6], wired: s[7], paid: s[8], lastAt: Number(s[9] || 0n) };
  }).sort((a, b) => Number(b.wired - a.wired));
  return { boxes };
}

export async function burnerStats() {
  if (!BURNER) return null;
  const { R } = await abis();
  const r = await pub.multicall({ allowFailure: true, contracts: ['totalReceived', 'burnedEth', 'burnedTokens'].map(f => ({ address: BURNER, abi: R, functionName: f })) });
  return { received: r[0].result || 0n, burnedEth: r[1].result || 0n, burnedTokens: r[2].result || 0n, balance: await pub.getBalance({ address: BURNER }).catch(() => 0n) };
}

/* who a coin actually pays, straight from the Pons factory record */
export async function checkRecipient(token) {
  const lt = await pub.readContract({ address: PONS, abi: PF, functionName: 'getLaunchedToken', args: [token] });
  if (!lt.exists) throw Error('That address is not a Pons token');
  return { recipient: lt.creatorFeeRecipient, curve: lt.curve, phase: Number(lt.phase), taxBps: Number(lt.creatorTaxBps) };
}

/* a coin only counts if Pons really points its creator fee at this box */
export async function checkCoin(token, box) {
  const lt = await pub.readContract({ address: PONS, abi: PF, functionName: 'getLaunchedToken', args: [token] });
  if (!lt.exists) throw Error('That address is not a Pons token');
  if (lt.creatorFeeRecipient.toLowerCase() !== String(box).toLowerCase()) throw Error('That coin pays its creator fee somewhere else');
  return lt;
}

export async function coinDetails(tokens) {
  if (!tokens.length) return [];
  const meta = await pub.multicall({ allowFailure: true, contracts: tokens.flatMap(t => [
    { address: t, abi: ERC20, functionName: 'name' },
    { address: t, abi: ERC20, functionName: 'symbol' },
    { address: PONS, abi: PF, functionName: 'getLaunchedToken', args: [t] }
  ]) });
  const out = tokens.map((token, i) => {
    const lt = meta[i * 3 + 2].result;
    return { token, name: meta[i * 3].result || '', symbol: meta[i * 3 + 1].result || '', curve: lt ? lt.curve : null, phase: lt ? Number(lt.phase) : 0, taxBps: lt ? Number(lt.creatorTaxBps) : 0 };
  });
  const live = out.filter(c => c.curve && c.phase < 2);
  if (live.length) {
    const cm = await pub.multicall({ allowFailure: true, contracts: live.flatMap(c => [
      { address: c.curve, abi: CURVE, functionName: 'realQuoteReserve' },
      { address: c.curve, abi: CURVE, functionName: 'graduationThreshold' },
      { address: c.curve, abi: CURVE, functionName: 'creatorTaxBalance' },
      { address: c.curve, abi: CURVE, functionName: 'quoteFeeBalance' }
    ]) });
    live.forEach((c, i) => {
      const raised = cm[i * 4].result || 0n, thr = cm[i * 4 + 1].result || 0n;
      c.progress = thr ? Math.min(1, Number(raised) / Number(thr)) : 0;
      c.unswept = (cm[i * 4 + 2].result || 0n) + (cm[i * 4 + 3].result || 0n);
    });
  }
  return out.map(c => ({ ...c, progress: c.progress || (c.phase >= 2 ? 1 : 0), unswept: c.unswept || 0n }));
}

export const escrowOf = box => pub.readContract({ address: ESCROW, abi: ESC, functionName: 'balanceOf', args: [box] }).catch(() => 0n);
export const usdgOf = who => pub.readContract({ address: USDG, abi: ERC20, functionName: 'balanceOf', args: [who] }).catch(() => 0n);

// ---------------------------------------------------------------- actions

const me = () => { const w = wallet(); if (!w.address) throw Error('Connect a wallet first'); return w.address; };
async function run(call, onStep) {
  onStep && onStep('Confirm in your wallet');
  const t = await send(CHAIN, call);
  onStep && onStep('Waiting for Robinhood Chain');
  const rc = await t.wait();
  if (rc.status !== 'success') throw Error('Transaction reverted');
  return rc;
}

export async function openBox(handle, onStep) {
  if (!OFFICE) throw Error('Wire Office is not deployed yet');
  me();
  return run({ address: OFFICE, abi: (await abis()).O, functionName: 'open', args: [handle] }, onStep);
}
export const runBox = async (box, curves, onStep) => run({ address: box, abi: (await abis()).B, functionName: 'run', args: [curves] }, onStep);
export const settleBox = async (box, onStep) => run({ address: box, abi: (await abis()).B, functionName: 'settle', args: [] }, onStep);
export const payout = async (box, onStep) => run({ address: box, abi: (await abis()).B, functionName: 'payout', args: [] }, onStep);
export const bind = async (box, to, deadline, signature, onStep) => run({ address: box, abi: (await abis()).B, functionName: 'bind', args: [to, BigInt(deadline), signature] }, onStep);
export const confirm = async (box, onStep) => run({ address: box, abi: (await abis()).B, functionName: 'confirm', args: [] }, onStep);

// ---------------------------------------------------------------- the site's own records

async function postJSON(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Request failed');
  return j;
}
export const coinsOf = handle => fetch('/api/coins?handle=' + encodeURIComponent(handle)).then(r => r.json()).then(j => j.coins || []).catch(() => []);
export const addCoin = (handle, token) => postJSON('/api/coins', { handle, token }).then(j => j.coins || []);
export const claimCode = (handle, wallet) => postJSON('/api/claim', { action: 'code', handle, wallet });
export const claimVerify = (handle, wallet, url) => postJSON('/api/claim', { action: 'verify', handle, wallet, url });
