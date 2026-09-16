/* The activity feed: what actually happened on chain, read from event logs.
   Archive log queries need the private endpoint (ROBINHOOD_RPC) — the public ones refuse ranges, which is
   why this lives on the server and not in the browser.
   GET /api/feed  -> { events: [{ kind, handle, wallet, amount, block, at }], head }
   Cached in Redis for a minute so a page full of visitors costs one scan, not one per visitor. */
import { parseAbiItem, formatEther, formatUnits } from 'viem';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';
import { pub } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const CACHE_KEY = 'wo:feed:v1', CACHE_SECONDS = 60;
const WINDOW = 300_000n, CHUNK = 9_000n, MAX_EVENTS = 40;

const BOX_OPENED = parseAbiItem('event BoxOpened(bytes32 indexed handleHash, address indexed box, string handle, address by)');
const WIRED = parseAbiItem('event Wired(uint256 ethIn, uint256 usdgOut, uint256 officeFee)');
const PAID = parseAbiItem('event Paid(address indexed wallet, uint256 usdg)');
const WALLET_SET = parseAbiItem('event WalletSet(address indexed wallet)');

async function scan(address, event, fromBlock, toBlock) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > toBlock ? toBlock : from + CHUNK;
    const logs = await pub.getLogs({ address, event, fromBlock: from, toBlock: to }).catch(() => []);
    out.push(...logs);
  }
  return out;
}

export default async function handler(req, res) {
  let R = null;
  try { R = redis(); } catch {}
  if (R) {
    const hit = await R.get(CACHE_KEY).catch(() => null);
    if (hit) { res.setHeader('x-cache', 'hit'); return json(res, 200, JSON.parse(hit)); }
  }
  const cfg = await siteConfig(req);
  if (!cfg.office) return json(res, 200, { events: [], head: null, note: 'not deployed yet' });

  try {
    const head = await pub.getBlockNumber();
    const from = head > WINDOW ? head - WINDOW : 0n;

    const opened = await scan(cfg.office, BOX_OPENED, from, head);
    const boxes = [...new Set(opened.map(l => l.args.box))];
    const handleOf = Object.fromEntries(opened.map(l => [l.args.box.toLowerCase(), l.args.handle]));

    const [wires, paids, wallets] = await Promise.all([
      boxes.length ? scan(boxes, WIRED, from, head) : [],
      boxes.length ? scan(boxes, PAID, from, head) : [],
      boxes.length ? scan(boxes, WALLET_SET, from, head) : []
    ]);

    const events = [
      ...opened.map(l => ({ kind: 'opened', block: Number(l.blockNumber), handle: l.args.handle, by: l.args.by })),
      ...wires.map(l => ({ kind: 'wired', block: Number(l.blockNumber), handle: handleOf[l.address.toLowerCase()] || null, usdg: formatUnits(l.args.usdgOut, 6), eth: formatEther(l.args.ethIn), fee: formatEther(l.args.officeFee) })),
      ...paids.map(l => ({ kind: 'paid', block: Number(l.blockNumber), handle: handleOf[l.address.toLowerCase()] || null, wallet: l.args.wallet, usdg: formatUnits(l.args.usdg, 6) })),
      ...wallets.map(l => ({ kind: 'claimed', block: Number(l.blockNumber), handle: handleOf[l.address.toLowerCase()] || null, wallet: l.args.wallet }))
    ].sort((a, b) => b.block - a.block).slice(0, MAX_EVENTS);

    const blocks = [...new Set(events.map(e => e.block))].slice(0, 12);
    const stamps = Object.fromEntries(await Promise.all(blocks.map(async b => [b, Number((await pub.getBlock({ blockNumber: BigInt(b) }).catch(() => ({ timestamp: 0n }))).timestamp)])));
    for (const e of events) e.at = stamps[e.block] || null;

    const payload = { events, head: Number(head) };
    if (R) await R.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_SECONDS }).catch(() => {});
    res.setHeader('x-cache', 'miss');
    return json(res, 200, payload);
  } catch (e) {
    return json(res, 200, { events: [], head: null, error: e.shortMessage || e.message });
  }
}
