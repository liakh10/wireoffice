/* The coins pointed at a handle's box.
   The office itself keeps no list: anyone can point a Pons coin at a delivery address without asking us, so the list
   here is only a convenience for the site. A coin is recorded only after the chain confirms that Pons really pays its
   creator fee to that handle's box, which makes the record impossible to fake.
   GET  /api/coins?handle=vladtenev  -> { coins: [address] }
   POST /api/coins { handle, token } -> { coins: [address] } */
import { getAddress } from 'viem';
import { redis } from '../lib/store.js';
import { json, ipOf, body } from '../lib/http.js';
import { pub, PONS, PONS_ABI, OFFICE_ABI, isAddr, validHandle, limit } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const key = handle => `wo:coins:${handle}`;
const MAX_PER_HANDLE = 60;

export default async function handler(req, res) {
  let R;
  try { R = redis(); } catch { return json(res, 200, { coins: [] }); }
  const q = req.query || {};

  if (req.method === 'GET') {
    const handle = String(q.handle || '').replace(/^@/, '').toLowerCase();
    if (!validHandle(handle)) return json(res, 400, { error: 'Bad handle' });
    const coins = await R.lrange(key(handle), 0, MAX_PER_HANDLE - 1).catch(() => []);
    return json(res, 200, { coins });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  try {
    const b = body(req);
    const handle = String(b.handle || '').replace(/^@/, '').toLowerCase();
    if (!validHandle(handle)) return json(res, 400, { error: 'Enter an X handle: letters, numbers and underscore, up to 15' });
    if (!isAddr(b.token)) return json(res, 400, { error: 'Paste the coin contract address' });
    if (!(await limit(R, 'wo:rl:coins:' + ipOf(req), 40, 600))) return json(res, 429, { error: 'Too many requests, try again in a few minutes' });

    const { office } = await siteConfig(req);
    if (!office) return json(res, 503, { error: 'Wire Office is not deployed yet' });
    const token = getAddress(b.token);

    const [box, lt] = await Promise.all([
      pub.readContract({ address: office, abi: OFFICE_ABI, functionName: 'addressFor', args: [handle] }),
      pub.readContract({ address: PONS, abi: PONS_ABI, functionName: 'getLaunchedToken', args: [token] }).catch(() => null)
    ]);
    if (!lt || !lt.exists) return json(res, 404, { error: 'That address is not a Pons token' });
    if (lt.creatorFeeRecipient.toLowerCase() !== box.toLowerCase()) {
      return json(res, 403, { error: `That coin pays its creator fee to ${lt.creatorFeeRecipient}, not to @${handle}` });
    }

    const existing = await R.lrange(key(handle), 0, MAX_PER_HANDLE - 1).catch(() => []);
    if (!existing.some(a => a.toLowerCase() === token.toLowerCase())) {
      if (existing.length >= MAX_PER_HANDLE) return json(res, 409, { error: 'That handle already lists the maximum number of coins' });
      await R.lpush(key(handle), token);
      await R.ltrim(key(handle), 0, MAX_PER_HANDLE - 1);
      await R.lpush('wo:recent', JSON.stringify({ handle, token, at: Date.now() }));
      await R.ltrim('wo:recent', 0, 199);
    }
    const coins = await R.lrange(key(handle), 0, MAX_PER_HANDLE - 1).catch(() => []);
    return json(res, 200, { coins });
  } catch (e) {
    return json(res, 500, { error: e.shortMessage || e.message || 'Server error' });
  }
}
