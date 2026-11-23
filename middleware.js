import { next } from '@vercel/functions';
import { createClient } from '@vercel/edge-config';
import { getClientIp, isIpInCidr, isWhitelistedIp } from './lib/ip-match.js';

export const config = {
  matcher: [
    '/',
    '/index.html',
    '/hsk1/:path*',
    '/hsk2/:path*',
    '/hsk3/:path*',
    '/hsk4/:path*',
    '/api/:path*'
  ]
};

const STATIC_EXT_RE = /\.(css|png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|woff2?|ttf|map)$/i;

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatVnDateTime(iso) {
  if (!iso) return 'Không thời hạn';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function renderBlockedHtml({ ip, reason, expiresAt }) {
  const reasonLine = reason
    ? `<p class="meta"><strong>Lý do:</strong> ${escapeHtml(reason)}</p>`
    : '';
  const expiryLine = `<p class="meta"><strong>Thời hạn mở khóa:</strong> ${escapeHtml(formatVnDateTime(expiresAt))}</p>`;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Truy cập bị hạn chế · HSK 3.0</title>
<style>
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #fdf8f2; color: #2a2520; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 20px;
  }
  .card {
    max-width: 440px; width: 100%; background: #fff; border: 1px solid #ece4d8;
    border-radius: 18px; padding: 28px 24px; text-align: center;
    box-shadow: 0 12px 32px rgba(42, 37, 32, 0.08);
  }
  .badge {
    display: inline-block; background: #fdecea; color: #c62828; font-weight: 700;
    font-size: 12px; padding: 5px 12px; border-radius: 999px; margin-bottom: 12px;
  }
  h1 { margin: 0 0 10px; font-size: 21px; }
  p { margin: 0 0 12px; font-size: 14px; line-height: 1.55; color: #665e55; }
  .meta { background: #faf5ee; border-radius: 10px; padding: 10px 12px; color: #2a2520; text-align: left; }
  .ip { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #8c8276; margin-top: 14px; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">HTTP 403 · TRUY CẬP BỊ HẠN CHẾ</div>
    <h1>Địa chỉ IP của bạn đang bị tạm chặn</h1>
    <p>Hệ thống quản trị đã hạn chế quyền truy cập trang ôn tập HSK từ địa chỉ mạng này.</p>
    ${reasonLine}
    ${expiryLine}
    <div class="ip">IP của bạn: ${escapeHtml(ip)}</div>
  </div>
</body>
</html>`;
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // Skip pure static asset files inside matched folders (e.g. theme.css)
  if (STATIC_EXT_RE.test(url.pathname)) {
    return next();
  }

  // Support both Vercel Global Config (GLOBAL_CONFIG) and legacy Edge Config (EDGE_CONFIG)
  const configConn = process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG;
  if (!configConn) {
    return next();
  }

  const ip = getClientIp(request);

  // Emergency whitelist: never block whitelisted admin IPs
  if (isWhitelistedIp(ip, process.env.ADMIN_WHITELIST_IPS)) {
    return next();
  }

  let rules = [];
  try {
    const client = createClient(configConn);
    const val = await client.get('blocked_ips');
    if (Array.isArray(val)) rules = val;
  } catch {
    return next();
  }

  if (!rules.length) {
    return next();
  }

  const now = Date.now();
  const isAdminApi = url.pathname.startsWith('/api/admin');

  for (const rule of rules) {
    if (!rule || !rule.cidr) continue;
    if (rule.expiresAt && Date.parse(rule.expiresAt) <= now) continue;

    const scope = rule.scope || 'site_wide';
    const applies = scope === 'site_wide' || (scope === 'admin_only' && isAdminApi);
    if (!applies) continue;

    if (isIpInCidr(ip, rule.cidr)) {
      if (url.pathname.startsWith('/api/')) {
        return new Response(
          JSON.stringify({
            error: 'Địa chỉ IP của bạn đang bị chặn truy cập.',
            reason: rule.reason || '',
            expiresAt: rule.expiresAt || null
          }),
          {
            status: 403,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store'
            }
          }
        );
      }

      return new Response(
        renderBlockedHtml({ ip, reason: rule.reason, expiresAt: rule.expiresAt }),
        {
          status: 403,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        }
      );
    }
  }

  return next();
}
