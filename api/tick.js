/* Keeper (GitHub Actions cron with CRON_SECRET, or a page poke at most every 10 minutes).
   Everything it does is permissionless: anyone can run their own keeper and the result is the same.
   1. run    for every open box that has fees waiting: sweep its coins' curves, claim the escrow, settle into USDG
   2. burn   once $WIRE is set on the burner and it holds at least 0.02 ETH, buy $WIRE and send it to dead
   The key is WIRE_OPERATOR_KEY and it only pays gas. It cannot move a box's dollars anywhere but to its handle. */
import { createWalletClient, http, fallback, parseAbi, parseEther, formatEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';
import { pub, chain, RPCS, PONS, PONS_ABI, CURVE_ABI, ESCROW, ESCROW_ABI, OFFICE_ABI, BOX_ABI } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const MIN_WORK = parseEther('0.002'), MIN_BURN = parseEther('0.02');
const BUDGET_MS = 45000;
const B = parseAbi(['function wire() view returns (address)', 'function burn(uint256 ethIn, uint256 minOut)']);

function operator() {
  const key = process.env.WIRE_OPERATOR_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw Error('The keeper wallet is not configured yet.');
  const account = privateKeyToAccount(key);
  return { account, address: account.address, wallet: createWalletClient({ account, chain, transport: fallback(RPCS.map(u => http(u, { timeout: 30000 }))) }) };
}
async function sendTx(o, tx) {
  const hash = await o.wallet.sendTransaction({ account: o.account, chain, ...tx });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
  if (rc.status !== 'success') throw Error('Transaction reverted ' + hash);
  return hash;
}

async function openBoxes(office) {
  const n = Number(await pub.readContract({ address: office, abi: OFFICE_ABI, functionName: 'handleCount' }).catch(() => 0n));
  let names = [], boxes = [];
  for (let i = 0; i < n; i += 200) {
    const [ns, bs] = await pub.readContract({ address: office, abi: OFFICE_ABI, functionName: 'handles', args: [BigInt(i), 200n] });
    names = names.concat(ns); boxes = boxes.concat(bs);
  }
  return names.map((handle, i) => ({ handle, box: boxes[i] }));
}

/* The curves of the coins this handle's box is owed fees by, and whether there is enough to be worth a transaction. */
async function workFor(R, entry) {
  const tokens = await R.lrange(`wo:coins:${entry.handle}`, 0, 59).catch(() => []);
  let curves = [], unswept = 0n;
  if (tokens.length) {
    const lts = await pub.multicall({ allowFailure: true, contracts: tokens.map(t => ({ address: PONS, abi: PONS_ABI, functionName: 'getLaunchedToken', args: [t] })) });
    const live = lts.map(r => r.result).filter(lt => lt && lt.exists && Number(lt.phase) < 2 && lt.creatorFeeRecipient.toLowerCase() === entry.box.toLowerCase());
    if (live.length) {
      const bals = await pub.multicall({ allowFailure: true, contracts: live.flatMap(lt => [
        { address: lt.curve, abi: CURVE_ABI, functionName: 'creatorTaxBalance' },
        { address: lt.curve, abi: CURVE_ABI, functionName: 'quoteFeeBalance' }
      ]) });
      live.forEach((lt, i) => {
        const owed = (bals[i * 2].result || 0n) + (bals[i * 2 + 1].result || 0n);
        if (owed > 0n) { curves.push(lt.curve); unswept += owed; }
      });
    }
  }
  const [escrowed, balance] = await Promise.all([
    pub.readContract({ address: ESCROW, abi: ESCROW_ABI, functionName: 'balanceOf', args: [entry.box] }).catch(() => 0n),
    pub.getBalance({ address: entry.box }).catch(() => 0n)
  ]);
  return { curves, total: unswept + escrowed + balance };
}

async function burn(o, burner, log) {
  const [wire, balance] = await Promise.all([
    pub.readContract({ address: burner, abi: B, functionName: 'wire' }).catch(() => ZERO),
    pub.getBalance({ address: burner })
  ]);
  if (wire === ZERO) return log.push({ burn: 'waiting for $WIRE to be set on the burner' });
  if (balance < MIN_BURN) return log.push({ burn: 'under 0.02 ETH, waiting', balance: formatEther(balance) });
  const ethIn = balance > parseEther('0.5') ? parseEther('0.5') : balance;
  const hash = await sendTx(o, { to: burner, data: encodeFunctionData({ abi: B, functionName: 'burn', args: [ethIn, 1n] }) });
  log.push({ burned: formatEther(ethIn) + ' ETH of office fees into $WIRE', tx: hash });
}

export default async function handler(req, res) {
  let R;
  try { R = redis(); } catch { return json(res, 200, { ok: false, skipped: 'storage is not connected yet' }); }
  const q = req.query || {}, secret = process.env.CRON_SECRET;
  const authed = secret && (req.headers.authorization === 'Bearer ' + secret || q.secret === secret);
  if (!authed && !(await R.set('wo:poke', '1', { nx: true, ex: 600 }))) return json(res, 200, { ok: true, skipped: 'recent run' });
  let o;
  try { o = operator(); } catch (e) { return json(res, 200, { ok: false, skipped: e.message }); }
  const cfg = await siteConfig(req);
  if (!cfg.office) return json(res, 200, { ok: false, skipped: 'the office is not in config.js yet' });
  const lock = Math.random().toString(36).slice(2);
  if (!(await R.set('wo:lock:keeper', lock, { nx: true, px: 58000 }))) return json(res, 200, { ok: true, skipped: 'keeper busy' });
  const log = [], started = Date.now();
  try {
    const boxes = await openBoxes(cfg.office);
    for (const entry of boxes) {
      if (Date.now() - started > BUDGET_MS) { log.push({ partial: 'out of time, the rest waits for the next run' }); break; }
      const { curves, total } = await workFor(R, entry).catch(() => ({ curves: [], total: 0n }));
      if (total < MIN_WORK) continue;
      const hash = await sendTx(o, { to: entry.box, data: encodeFunctionData({ abi: BOX_ABI, functionName: 'run', args: [curves] }) })
        .catch(e => { log.push({ handle: entry.handle, runError: e.shortMessage || e.message }); return null; });
      if (hash) log.push({ wired: entry.handle, curves: curves.length, eth: formatEther(total), tx: hash });
    }
    if (cfg.burner) await burn(o, cfg.burner, log).catch(e => log.push({ burnError: e.shortMessage || e.message }));
    json(res, 200, { ok: true, boxes: boxes.length, keeper: o.address, log });
  } catch (e) {
    json(res, 200, { ok: false, error: e.shortMessage || e.message, log });
  } finally {
    if ((await R.get('wo:lock:keeper')) === lock) await R.del('wo:lock:keeper');
  }
}
