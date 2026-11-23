/**
 * Edge-safe & Node-safe IP / CIDR utilities and User-Agent parser.
 * Zero Node.js built-ins so it runs identically in Vercel Edge Middleware and Serverless Functions.
 */

export function normalizeIp(raw) {
  if (!raw || typeof raw !== 'string') return '0.0.0.0';
  let ip = raw.split(',')[0].trim();
  if (!ip) return '0.0.0.0';
  // Strip brackets around IPv6 like [::1]
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }
  // Strip IPv4-mapped IPv6 prefix
  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  // Strip port on IPv4 like 1.2.3.4:12345
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.split(':')[0];
  }
  return ip;
}

export function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const key = name.toLowerCase();
  const val = headers[key] ?? headers[name];
  if (Array.isArray(val)) return val[0] || '';
  return val || '';
}

export function getClientIp(req) {
  const h = req?.headers;
  const raw =
    getHeader(h, 'x-real-ip') ||
    getHeader(h, 'cf-connecting-ip') ||
    getHeader(h, 'x-forwarded-for') ||
    req?.socket?.remoteAddress ||
    '127.0.0.1';
  return normalizeIp(raw);
}

export function getClientGeo(req) {
  const h = req?.headers;
  const country = getHeader(h, 'x-vercel-ip-country') || getHeader(h, 'cf-ipcountry') || '';
  const rawCity = getHeader(h, 'x-vercel-ip-city') || '';
  let city = '';
  if (rawCity) {
    try {
      city = decodeURIComponent(rawCity);
    } catch {
      city = rawCity;
    }
  }
  return { country: country.slice(0, 12), city: city.slice(0, 80) };
}

export function parseUserAgent(uaRaw = '') {
  const ua = String(uaRaw || '');
  const low = ua.toLowerCase();

  let device_type = 'desktop';
  if (/bot|crawl|spider|slurp|curl|wget|python-requests|headless|postman|lighthouse/i.test(low)) {
    device_type = 'bot';
  } else if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(low)) {
    device_type = 'tablet';
  } else if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i.test(low)) {
    device_type = 'mobile';
  }

  let os_name = 'Other';
  if (/iphone|ipad|ipod/i.test(low)) os_name = 'iOS';
  else if (/android/i.test(low)) os_name = 'Android';
  else if (/windows nt/i.test(low)) os_name = 'Windows';
  else if (/mac os x|macintosh/i.test(low)) os_name = 'macOS';
  else if (/cros/i.test(low)) os_name = 'ChromeOS';
  else if (/linux/i.test(low)) os_name = 'Linux';

  let browser_name = 'Other';
  if (/coc_coc_browser/i.test(low)) browser_name = 'Cốc Cốc';
  else if (/edg\//i.test(low)) browser_name = 'Edge';
  else if (/opr\/|opera/i.test(low)) browser_name = 'Opera';
  else if (/zalo/i.test(low)) browser_name = 'Zalo';
  else if (/fban|fbav/i.test(low)) browser_name = 'Facebook';
  else if (/samsungbrowser/i.test(low)) browser_name = 'Samsung Internet';
  else if (/firefox|fxios/i.test(low)) browser_name = 'Firefox';
  else if (/chrome|crios/i.test(low)) browser_name = 'Chrome';
  else if (/safari/i.test(low)) browser_name = 'Safari';

  return { device_type, os_name, browser_name };
}

export function getClientInfo(req) {
  const ip = getClientIp(req);
  const { country, city } = getClientGeo(req);
  const user_agent = getHeader(req?.headers, 'user-agent').slice(0, 500);
  const { device_type, os_name, browser_name } = parseUserAgent(user_agent);
  return { ip, country, city, device_type, os_name, browser_name, user_agent };
}

function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    num = (num * 256) + n;
  }
  return num >>> 0;
}

function expandIpv6(ip) {
  if (!ip.includes(':')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const full = [...left, ...Array(missing).fill('0'), ...right];
  if (full.length !== 8) return null;
  let val = 0n;
  for (const seg of full) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
    val = (val << 16n) + BigInt(parseInt(seg, 16));
  }
  return val;
}

export function isValidIpOrCidr(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const [addrRaw, prefixRaw] = raw.split('/');
  const addr = normalizeIp(addrRaw);
  const v4 = parseIpv4(addr);
  if (v4 !== null) {
    const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    return `${addr}/${prefix}`;
  }
  const v6 = expandIpv6(addr);
  if (v6 !== null) {
    const prefix = prefixRaw === undefined ? 128 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    return `${addr.toLowerCase()}/${prefix}`;
  }
  return null;
}

export function isIpInCidr(ipRaw, cidrRaw) {
  const ip = normalizeIp(ipRaw);
  const [netRaw, prefixRaw] = String(cidrRaw || '').trim().split('/');
  const net = normalizeIp(netRaw);

  const ipV4 = parseIpv4(ip);
  const netV4 = parseIpv4(net);
  if (ipV4 !== null && netV4 !== null) {
    const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (ipV4 & mask) === (netV4 & mask);
  }

  const ipV6 = expandIpv6(ip);
  const netV6 = expandIpv6(net);
  if (ipV6 !== null && netV6 !== null) {
    const prefix = prefixRaw === undefined ? 128 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
    if (prefix === 0) return true;
    const shift = BigInt(128 - prefix);
    return (ipV6 >> shift) === (netV6 >> shift);
  }

  return ip.toLowerCase() === net.toLowerCase();
}

export function isWhitelistedIp(ip, whitelistEnv = '') {
  if (!whitelistEnv) return false;
  const list = String(whitelistEnv)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return list.some(cidr => isIpInCidr(ip, cidr));
}
