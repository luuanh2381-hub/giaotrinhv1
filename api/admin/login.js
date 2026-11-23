import { getDb, readJsonBody } from '../../lib/db.js';
import { getClientInfo, isWhitelistedIp } from '../../lib/ip-match.js';
import {
  ensureInitialAdmin,
  verifyPassword,
  signAdminToken,
  setSessionCookie
} from '../../lib/auth.js';
import { syncBlockedIpsToEdgeConfig } from '../../lib/edge-sync.js';

const MAX_FAILED_ATTEMPTS = 5;
const FAILED_WINDOW_MIN = 10;
const AUTO_BAN_MINUTES = 30;

async function recordLoginLog(sql, client, username, status) {
  await sql`
    INSERT INTO admin_login_logs (
      username_tried, ip_address, country, city, device_type, os_name, browser_name, user_agent, status
    )
    VALUES (
      ${username.slice(0, 120)}, ${client.ip}::inet, ${client.country}, ${client.city},
      ${client.device_type}, ${client.os_name}, ${client.browser_name}, ${client.user_agent}, ${status}
    )
  `;

  if (status === 'failed' || status === 'auto_banned') {
    await sql`
      INSERT INTO visitor_ip_summary (
        ip_address, country, city, device_type, os_name, browser_name, total_hits, failed_admin_logins, last_path, first_seen_at, last_seen_at
      )
      VALUES (
        ${client.ip}::inet, ${client.country}, ${client.city}, ${client.device_type},
        ${client.os_name}, ${client.browser_name}, 1, 1, '/api/admin/login', NOW(), NOW()
      )
      ON CONFLICT (ip_address) DO UPDATE SET
        failed_admin_logins = visitor_ip_summary.failed_admin_logins + 1,
        device_type = EXCLUDED.device_type,
        os_name = EXCLUDED.os_name,
        browser_name = EXCLUDED.browser_name,
        last_seen_at = NOW()
    `;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const sql = getDb();
    const client = getClientInfo(req);
    const body = await readJsonBody(req);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu.' });
    }

    const whitelisted = isWhitelistedIp(client.ip, process.env.ADMIN_WHITELIST_IPS);

    // 1. Check active block in Neon (defense in depth even if Edge Config is not configured)
    if (!whitelisted) {
      const blocked = await sql`
        SELECT id, reason, expires_at
        FROM blocked_ips
        WHERE ${client.ip}::inet <<= ip_cidr
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `;
      if (blocked.length > 0) {
        await sql`UPDATE blocked_ips SET blocked_hits = blocked_hits + 1 WHERE id = ${blocked[0].id}`;
        await recordLoginLog(sql, client, username, 'blocked');
        return res.status(403).json({
          error: 'IP của bạn đang bị tạm khóa do chính sách bảo mật.',
          reason: blocked[0].reason || '',
          expiresAt: blocked[0].expires_at
        });
      }
    }

    // 2. Ensure initial admin exists from env vars if table is empty
    await ensureInitialAdmin();

    // 3. Verify credentials
    const users = await sql`
      SELECT id, username, password_hash, role
      FROM admin_users
      WHERE username = ${username}
      LIMIT 1
    `;
    const user = users[0];
    const valid = user ? await verifyPassword(password, user.password_hash) : false;

    if (!valid) {
      // Check failed attempts in recent window for auto-ban
      const recentFails = await sql`
        SELECT COUNT(*)::int AS cnt
        FROM admin_login_logs
        WHERE ip_address = ${client.ip}::inet
          AND status IN ('failed', 'auto_banned')
          AND created_at > NOW() - make_interval(mins => ${FAILED_WINDOW_MIN}::int)
      `;
      const failCount = (recentFails[0]?.cnt || 0) + 1;

      if (!whitelisted && failCount >= MAX_FAILED_ATTEMPTS) {
        const expiresAt = new Date(Date.now() + AUTO_BAN_MINUTES * 60 * 1000).toISOString();
        const cidr = client.ip.includes(':') ? `${client.ip}/128` : `${client.ip}/32`;
        await sql`
          INSERT INTO blocked_ips (ip_cidr, scope, reason, is_auto, blocked_by, expires_at, updated_at)
          VALUES (
            ${cidr}::cidr, 'site_wide',
            ${`Tự động khóa ${AUTO_BAN_MINUTES} phút do nhập sai mật khẩu Admin ${failCount} lần`},
            TRUE, 'system_autoban', ${expiresAt}::timestamptz, NOW()
          )
          ON CONFLICT (ip_cidr) DO UPDATE SET
            scope = 'site_wide',
            reason = EXCLUDED.reason,
            is_auto = TRUE,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
        `;
        await recordLoginLog(sql, client, username, 'auto_banned');
        await syncBlockedIpsToEdgeConfig().catch(() => {});
        return res.status(429).json({
          error: `Sai mật khẩu quá ${MAX_FAILED_ATTEMPTS} lần. IP của bạn đã bị tạm khóa ${AUTO_BAN_MINUTES} phút.`
        });
      }

      await recordLoginLog(sql, client, username, 'failed');
      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - failCount);
      return res.status(401).json({
        error: remaining > 0
          ? `Sai tài khoản hoặc mật khẩu. Còn ${remaining} lần thử trước khi tạm khóa IP.`
          : 'Sai tài khoản hoặc mật khẩu.'
      });
    }

    // 4. Success: update last_login_at, log success, set HttpOnly JWT cookie
    await sql`UPDATE admin_users SET last_login_at = NOW() WHERE id = ${user.id}`;
    await recordLoginLog(sql, client, user.username, 'success');

    const token = await signAdminToken({
      sub: String(user.id),
      username: user.username,
      role: user.role
    });
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { username: user.username, role: user.role },
      currentIp: client.ip
    });
  } catch (err) {
    console.error('[api/admin/login]', err);
    return res.status(500).json({
      error: err?.message || 'Lỗi máy chủ khi đăng nhập Admin.'
    });
  }
}
