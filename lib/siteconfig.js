/* Server-side view of config.js: the contract addresses the site is pointed at. Env vars win; otherwise config.js is
   read from the site itself, so changing it on GitHub is enough. Cached for a minute. */
const valid = v => /^0x[0-9a-fA-F]{40}$/.test(v || '') ? v : null;
let cache = { at: 0, value: null };

export async function siteConfig(req) {
  if (Date.now() - cache.at < 60000 && cache.value) return cache.value;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const origin = (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host;
  const text = await fetch(origin + '/config.js', { cache: 'no-store' }).then(r => r.text()).catch(() => '');
  const pick = name => { const m = text.match(new RegExp(name + '\\s*=\\s*"(0x[0-9a-fA-F]{40})"')); return m ? m[1] : null; };
  const ca = (text.match(/CA:\s*"(0x[0-9a-fA-F]{40})"/) || [])[1] || null;
  const value = {
    office: valid(process.env.WIRE_OFFICE) || pick('WIRE_OFFICE'),
    burner: valid(process.env.WIRE_BURNER) || pick('WIRE_BURNER'),
    ca: valid(process.env.WIRE_CA) || ca,
    origin
  };
  cache = { at: Date.now(), value };
  return value;
}
