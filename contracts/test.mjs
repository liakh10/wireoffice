/* Wire Office against a fork of Robinhood Chain mainnet (ethereumjs VM + RPCStateManager): the real Pons V2 factory,
   curve and fee escrow, Chainlink ETH/USD, the Uniswap V3 WETH/USDG pool and a graduated Pons token in its v4 pool.
   The coin is launched by a stranger who only names the handle's delivery address, exactly as it would happen in the
   wild. The oracle key is generated inside the test. No real keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes, setLengthLeft } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, encodeDeployData, parseAbi, formatEther, formatUnits, getAddress, keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://robinhood-rpc.publicnode.com';
const realFetch = globalThis.fetch;
let rpcRetries = 0;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(RPC)) return realFetch(url, opts);
  let last;
  for (let i = 0; i < 8; i++) {
    try { const text = await (await realFetch(url, opts)).text(); const j = JSON.parse(text); if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }); last = JSON.stringify(j.error || j); } catch (e) { last = e.message; }
    rpcRetries++;
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed: ' + last);
};

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const BOX = art('WireBox'), OFF = art('WireOffice'), BUR = art('WireBurner');
const ALL = [...BOX.abi, ...OFF.abi, ...BUR.abi].filter((x, i, a) => x.type !== 'event' || a.findIndex(y => y.type === 'event' && y.name === x.name) === i);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ESC = parseAbi(['function balanceOf(address) view returns (uint256)']);
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const PF = parseAbi([
  'function launchFee() view returns (uint256)',
  'function previewLaunchEconomics(uint256,address) view returns (bytes32)',
  'function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)',
  'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
  'function getLaunchFeePolicy(address) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))'
]);
const CURVE = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)', 'function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)', 'function sweepFees(uint256) external', 'function deployer() view returns (address)']);
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e', DEAD = '0x000000000000000000000000000000000000dEaD';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';
const GRADUATED = '0xCc50404bd4219245eaE40415D6BAb679180f7F7E';
const ZERO = '0x0000000000000000000000000000000000000000';
const E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL', label, extra); } };

class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}
const head = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()).result;
const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
const stateManager = new ForkState({ provider: RPC, blockTag: BigInt(head.number) });
stateManager._blockTag = 'latest';
const vm = await VM.create({ common, stateManager });
let now = BigInt(head.timestamp) + 12n;
const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });

async function exec(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 30_000_000n, value, block: block() });
  const e = r.execResult; let reason = null;
  if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue).slice(0, 80); } }
  const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: ALL, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
  return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed, created: r.createdAddress ? getAddress(r.createdAddress.toString()) : null };
}
async function tx(from, to, abi, functionName, args = [], value = 0n) {
  const r = await exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
  if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
  return r;
}
async function must(from, to, abi, fn, args, label, value = 0n) { const r = await tx(from, to, abi, fn, args, value); ok(!r.reverted, label, r.reason || ''); return r; }
async function reverts(from, to, abi, fn, args, expect, label, value = 0n) { const r = await tx(from, to, abi, fn, args, value); ok(r.reverted && (!expect || String(r.reason).includes(expect)), label, `reverted=${r.reverted} reason=${r.reason}`); }
const view = async (to, abi, fn, args = []) => { const r = await tx(addr(1), to, abi, fn, args); if (r.reverted) throw Error(fn + ' reverted: ' + r.reason); return r.result; };
const giveEth = async (who, wei) => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.balance = wei; await vm.stateManager.putAccount(a, acct); };
const ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;
const bal = (token, who) => view(token, ERC20, 'balanceOf', [who]);
async function deploy(from, a, args = []) {
  const r = await exec(from, null, args.length ? encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) : a.bytecode);
  if (r.reverted) throw Error('deploy failed ' + a.contractName + ' ' + r.reason);
  const who = Address.fromString(from), acct = (await vm.stateManager.getAccount(who)) ?? new Account();
  acct.nonce += 1n; await vm.stateManager.putAccount(who, acct);
  return r.created;
}

const guardian = addr(0xd0), stranger = addr(0xa1), trader = addr(0xb0), holder = addr(0xc0), other = addr(0xda), eve = addr(0xee);
for (const w of [guardian, stranger, trader, holder, other, eve]) await giveEth(w, E(20));
const oracleAcct = privateKeyToAccount(generatePrivateKey());
const rogue = privateKeyToAccount(generatePrivateKey());
console.log('fork block', Number(head.number), `· sizes office ${OFF.deployedSize}, box ${BOX.deployedSize}, burner ${BUR.deployedSize}`);

const boxImpl = await deploy(guardian, BOX);
const B = await deploy(guardian, BUR);
const O = await deploy(guardian, OFF, [boxImpl, oracleAcct.address, B]);
ok((await view(O, OFF.abi, 'guardian')) === guardian && (await view(O, OFF.abi, 'oracle')) === oracleAcct.address && (await view(O, OFF.abi, 'burner')) === B, 'office wired');
await reverts(eve, boxImpl, BOX.abi, 'initialize', ['x'], 'init', 'the box implementation is locked');

// ------------------------------------------------------------------ the address book
ok(!(await view(O, OFF.abi, 'validHandle', ['Elon'])) && !(await view(O, OFF.abi, 'validHandle', ['a'.repeat(16)])) && (await view(O, OFF.abi, 'validHandle', ['vlad_tenev1'])), 'handle rules: lowercase a-z 0-9 _, up to 15');
await reverts(eve, O, OFF.abi, 'addressFor', ['Elon'], 'handle', 'an invalid handle has no address');
const HANDLE = 'vladtenev';
const predicted = await view(O, OFF.abi, 'addressFor', [HANDLE]);
ok(/^0x[0-9a-fA-F]{40}$/.test(predicted) && predicted !== ZERO, 'the handle has a delivery address before anything is deployed', predicted);
ok((await view(O, OFF.abi, 'boxFor', [HANDLE])) === ZERO && !(await view(O, OFF.abi, 'isOpen', [HANDLE])), 'and no box is deployed yet');
{
  const code = await vm.stateManager.getContractCode(Address.fromString(predicted));
  ok(code.length === 0, 'nothing lives at that address yet');
}

// ------------------------------------------------------------------ a stranger launches a coin pointed at the handle
const fee = await view(PONS, PF, 'launchFee');
const economics = await view(PONS, PF, 'previewLaunchEconomics', [0n, ZERO]);
console.log('  pons launch fee', formatEther(fee));
async function launch(from, name, symbol, recipient, saltSeed) {
  const params = {
    name, symbol, logo: '', description: 'wired to @' + HANDLE,
    socials: { twitter: 'https://x.com/' + HANDLE, telegram: '', discord: '', website: '', farcaster: '' },
    creatorFeeRecipient: recipient, creatorTaxBps: 300, buybackEnabled: false,
    expectedEconomics: economics, salt: keccak256(toBytes(saltSeed))
  };
  const r = await tx(from, PONS, PF, 'launchToken', [params, 0n, ZERO], fee);
  if (r.reverted) throw Error('launch reverted: ' + r.reason);
  const [token, curve] = r.result;
  return { token, curve, gas: r.gas };
}
const c1 = await launch(stranger, 'Vlad Wire', 'VWIRE', predicted, 'wire-1');
console.log(`  a stranger launched ${c1.token} paying fees to ${predicted}`);
const lt1 = await view(PONS, PF, 'getLaunchedToken', [c1.token]);
ok(lt1.exists && lt1.creatorFeeRecipient === predicted && lt1.creatorTaxBps === 300 && lt1.phase === 0, 'Pons points the creator fee at the handle address', `recipient ${lt1.creatorFeeRecipient}`);
const curveDeployer = await view(c1.curve, CURVE, 'deployer');
ok(curveDeployer === predicted, 'Pons records the fee recipient as the curve deployer, so the box may sweep', `deployer ${curveDeployer} vs launcher ${stranger}`);

// ------------------------------------------------------------------ trading before the box exists
now += 120n;
for (const [w, v] of [[trader, 0.6], [other, 0.5], [eve, 0.4]]) {
  const r = await tx(w, c1.curve, CURVE, 'buy', [E(v), 1n, w], E(v));
  ok(!r.reverted, 'a trader buys on the curve', r.reason || '');
}
const policy = await view(PONS, PF, 'getLaunchFeePolicy', [c1.token]);
const taxBefore = await view(c1.curve, CURVE, 'creatorTaxBalance');
const feeBefore = await view(c1.curve, CURVE, 'quoteFeeBalance');
const expectedEscrow = taxBefore + feeBefore * BigInt(10000 - policy.protocolFeeShareBps) / 10000n;
ok(taxBefore > 0n && (await view(ESCROW, ESC, 'balanceOf', [predicted])) === 0n, 'fees pile up on the curve while the box is still counterfactual');

// ------------------------------------------------------------------ opening the box
const op = await must(eve, O, OFF.abi, 'open', [HANDLE], 'anyone opens the box of a handle');
const ev = op.logs.find(l => l.eventName === 'BoxOpened');
const BOXA = ev && ev.args.box;
ok(BOXA === predicted, 'the box landed on exactly the predicted address', `${BOXA} vs ${predicted}`);
ok((await view(O, OFF.abi, 'isOpen', [HANDLE])) && (await view(O, OFF.abi, 'handleCount')) === 1n, 'the office lists the handle');
ok((await view(BOXA, BOX.abi, 'handle')) === HANDLE, 'the box knows its handle');
const again = await must(other, O, OFF.abi, 'open', [HANDLE], 'opening twice is harmless');
ok(!again.logs.some(l => l.eventName === 'BoxOpened'), 'and does not redeploy');

// ------------------------------------------------------------------ sweep, collect, settle
{
  const rogueSweep = await exec(eve, c1.curve, encodeFunctionData({ abi: CURVE, functionName: 'sweepFees', args: [0n] }));
  ok(rogueSweep.reverted, 'Pons lets nobody but the box sweep its curve');
}
{
  const junk = await must(eve, BOXA, BOX.abi, 'sweep', [[addr(0x1234)]], 'an address with no code does not take the sweep down');
  ok(junk.logs.some(l => l.eventName === 'Swept' && !l.args.ok), 'it is simply reported as skipped');
}
const sw = await must(eve, BOXA, BOX.abi, 'sweep', [[c1.curve]], 'anyone asks the box to sweep its curve');
ok(sw.logs.filter(l => l.eventName === 'Swept' && l.args.ok).length === 1, 'the curve swept because Pons treats the box as its deployer');
const escrowed = await view(ESCROW, ESC, 'balanceOf', [BOXA]);
ok(escrowed > 0n && (escrowed >= expectedEscrow ? escrowed - expectedEscrow : expectedEscrow - escrowed) <= 3n, 'the box is owed the creator tax plus the creator share of the curve fee', `${formatEther(escrowed)} vs ${formatEther(expectedEscrow)}`);
console.log(`  box owed ${formatEther(escrowed)} ETH from 1.5 ETH of buys (${(Number(escrowed * 10000n / E(1.5)) / 100).toFixed(2)}%)`);

const col = await must(eve, BOXA, BOX.abi, 'collect', [], 'anyone collects the escrow');
ok(col.logs.some(l => l.eventName === 'Collected' && l.args.eth === escrowed) && (await ethBal(BOXA)) === escrowed, 'the ETH is in the box');

const burnerBefore = await ethBal(B);
const [, ethAns] = await view(ETH_USD, FEED, 'latestRoundData');
const set = await must(eve, BOXA, BOX.abi, 'settle', [], 'anyone settles the box into dollars');
const wired = set.logs.find(l => l.eventName === 'Wired') || { args: { officeFee: 0n, ethIn: 0n, usdgOut: 0n } };
ok(wired && wired.args.officeFee === escrowed * 500n / 10000n && (await ethBal(B)) - burnerBefore === wired.args.officeFee, 'the office keeps 5% for the $WIRE burn');
const expectedUsdg = wired ? wired.args.ethIn * ethAns / 10n ** 20n : 0n;
const devBps = wired && wired.args.usdgOut > 0n ? Number((wired.args.usdgOut - expectedUsdg) * 10000n / expectedUsdg) : null;
ok(wired && wired.args.ethIn === escrowed - wired.args.officeFee && wired.args.usdgOut > 0n && Math.abs(devBps) < 150, 'the rest became USDG within 1.5% of Chainlink', `$${formatUnits(wired ? wired.args.usdgOut : 0n, 6)} · ${devBps} bps · gas ${set.gas}`);
ok((await bal(USDG, BOXA)) === wired.args.usdgOut && (await ethBal(BOXA)) === 0n, 'the dollars wait in the box');
await reverts(eve, BOXA, BOX.abi, 'uniswapV3SwapCallback', [1n, 0n, '0x'], 'pool', 'the swap callback only fires during a settle');
await reverts(eve, BOXA, BOX.abi, 'payout', [], 'no wallet', 'nothing is paid before the handle binds a wallet');

// ------------------------------------------------------------------ binding
const sign = async (acct, to, n, deadline) => acct.sign({ hash: await view(BOXA, BOX.abi, 'bindDigest', [to, n, deadline]) });
const deadline = now + 3600n;
await reverts(eve, BOXA, BOX.abi, 'bind', [holder, deadline, await sign(rogue, holder, 0n, deadline)], 'oracle', 'a signature from anyone but the oracle is refused');
await reverts(eve, BOXA, BOX.abi, 'bind', [holder, now - 1n, await sign(oracleAcct, holder, 0n, now - 1n)], 'deadline', 'an expired signature is refused');
const sig0 = await sign(oracleAcct, holder, 0n, deadline);
const bd = await must(eve, BOXA, BOX.abi, 'bind', [holder, deadline, sig0], 'anyone submits the oracle signature');
ok(bd.logs.some(l => l.eventName === 'BindStarted') && (await view(BOXA, BOX.abi, 'pendingWallet')) === holder && (await view(BOXA, BOX.abi, 'nonce')) === 1n, 'binding pending for 48 hours');
await reverts(eve, BOXA, BOX.abi, 'bind', [holder, deadline, sig0], 'oracle', 'the same signature cannot be replayed');
await reverts(holder, BOXA, BOX.abi, 'confirm', [], 'wait', 'confirm waits 48 hours');
await reverts(eve, BOXA, BOX.abi, 'cancelBind', [], 'guardian', 'a stranger cannot cancel');
await must(guardian, BOXA, BOX.abi, 'cancelBind', [], 'the guardian cancels a suspicious binding');
ok((await view(BOXA, BOX.abi, 'pendingWallet')) === ZERO, 'binding cleared');
const sig1 = await sign(oracleAcct, holder, 1n, deadline);
await must(eve, BOXA, BOX.abi, 'bind', [holder, deadline, sig1], 'the handle binds again with a fresh signature');
now += 48n * 3600n + 1n;
await must(eve, BOXA, BOX.abi, 'confirm', [], 'anyone confirms after 48 hours');
ok((await view(BOXA, BOX.abi, 'wallet')) === holder, 'the wallet is set');
const h0 = await bal(USDG, holder), boxUsdg = await bal(USDG, BOXA);
await must(eve, BOXA, BOX.abi, 'payout', [], 'anyone pays the box out');
ok((await bal(USDG, holder)) - h0 === boxUsdg && (await bal(USDG, BOXA)) === 0n, 'every dollar reached the handle', '$' + formatUnits(boxUsdg, 6));

// later fees are wired straight through
for (const w of [trader, other]) { const r = await tx(w, c1.curve, CURVE, 'buy', [E(0.3), 1n, w], E(0.3)); ok(!r.reverted, 'more trading', r.reason || ''); }
const h1 = await bal(USDG, holder);
const run = await must(eve, BOXA, BOX.abi, 'run', [[c1.curve]], 'sweep, collect and settle in one call');
ok((await bal(USDG, holder)) > h1 && (await bal(USDG, BOXA)) === 0n && (await ethBal(BOXA)) === 0n, 'the run wired the dollars straight to the handle', `gas ${run.gas}`);

// a second coin from a different launcher feeds the same box
const c2 = await launch(other, 'Vlad Two', 'VWIRE2', predicted, 'wire-2');
now += 120n;
await must(trader, c2.curve, CURVE, 'buy', [E(0.4), 1n, trader], 'someone trades the second coin', E(0.4));
const h2 = await bal(USDG, holder);
await must(eve, BOXA, BOX.abi, 'run', [[c2.curve]], 'the same box collects the second coin');
ok((await bal(USDG, holder)) > h2, 'two coins from two strangers feed one handle');

// the wallet itself can cancel a binding to someone else
const sig2 = await sign(oracleAcct, other, 2n, now + 3600n);
await must(eve, BOXA, BOX.abi, 'bind', [other, now + 3600n, sig2], 'a new binding starts');
await must(holder, BOXA, BOX.abi, 'cancelBind', [], 'the current wallet cancels it');
ok((await view(BOXA, BOX.abi, 'wallet')) === holder, 'the wallet stays');

// stale prices: the ETH waits instead of reverting
await giveEth(BOXA, E(0.01));
now += 6n * 86400n;
const stale = await must(eve, BOXA, BOX.abi, 'settle', [], 'settling on stale Chainlink prices does not revert');
ok(!stale.logs.some(l => l.eventName === 'Wired') && (await ethBal(BOXA)) === E(0.01), 'nothing was swapped and the ETH waits');
now -= 6n * 86400n;

// ------------------------------------------------------------------ oracle rotation
await reverts(eve, O, OFF.abi, 'proposeOracle', [eve], 'guardian', 'only the guardian proposes an oracle');
await must(guardian, O, OFF.abi, 'proposeOracle', [rogue.address], 'the guardian proposes a new oracle');
await reverts(eve, O, OFF.abi, 'activateOracle', [], 'wait', 'a new oracle waits 48 hours');
now += 48n * 3600n + 1n;
await must(eve, O, OFF.abi, 'activateOracle', [], 'anyone activates it after the notice');
ok((await view(O, OFF.abi, 'oracle')) === rogue.address, 'oracle rotated');

// ------------------------------------------------------------------ burner
await reverts(eve, B, BUR.abi, 'burn', [E(0.01), 1n], 'wire not set', 'the burner waits for $WIRE');
await reverts(eve, B, BUR.abi, 'setWire', [c1.token], 'owner', 'only the owner sets $WIRE');
await must(guardian, B, BUR.abi, 'setWire', [c1.token], 'the owner sets a stand-in $WIRE');
await reverts(guardian, B, BUR.abi, 'setWire', [c2.token], 'set', '$WIRE is set once');
await exec(stranger, B, '0x', E(0.6));
await reverts(eve, B, BUR.abi, 'burn', [E(0.01), 0n], 'min out', 'a burn needs a minimum output');
await reverts(eve, B, BUR.abi, 'burn', [E(0.6), 1n], 'amount', 'a burn is capped at 0.5 ETH');
{
  const d0 = await bal(c1.token, DEAD);
  const r = await must(eve, B, BUR.abi, 'burn', [E(0.05), 1n], 'anyone burns on the Pons curve');
  const b = r.logs.find(l => l.eventName === 'Burned');
  ok(b && b.args.onCurve && (await bal(c1.token, DEAD)) - d0 === b.args.tokens && b.args.tokens > 0n, 'the curve buy landed on the dead address', b && formatEther(b.args.tokens));
}
await vm.stateManager.putContractStorage(Address.fromString(B), hexToBytes('0x' + '1'.padStart(64, '0')), setLengthLeft(hexToBytes(GRADUATED), 32));
ok((await view(B, BUR.abi, 'wire')) === GRADUATED, 'stand-in swapped to a graduated Pons token');
{
  const d0 = await bal(GRADUATED, DEAD);
  const r = await must(eve, B, BUR.abi, 'burn', [E(0.05), 1n], 'anyone burns a graduated token in its v4 pool');
  const b = r.logs.find(l => l.eventName === 'Burned');
  ok(b && !b.args.onCurve && (await bal(GRADUATED, DEAD)) - d0 === b.args.tokens && b.args.tokens > 0n, 'the v4 buy landed on the dead address', b && formatEther(b.args.tokens));
}
await reverts(eve, B, BUR.abi, 'unlockCallback', ['0x'], 'pool manager', 'the v4 callback only fires from the PoolManager');

// ------------------------------------------------------------------ no way out
ok(!ALL.some(x => x.type === 'function' && /withdraw|rescue|recover|sweepEth|setFee|setRecipient/i.test(x.name)), 'no function moves a box\'s money anywhere but to its handle');
ok(!OFF.abi.some(x => x.type === 'function' && /pause/i.test(x.name)), 'the office has no pause: a handle cannot be cut off from its money');

console.log(`\n${pass} passed, ${fail} failed · rpc retries ${rpcRetries}`);
process.exit(fail ? 1 : 0);
