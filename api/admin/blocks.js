import { getDb, readJsonBody } from '../../lib/db.js';
import { requireAdmin } from '../../lib/auth.js';
import { getClientInfo, isValidIpOrCidr, isIpInCidr } from '../../lib/ip-match.js';
import { getEdgeConfigStatus, syncBlockedIpsToEdgeConfig } from '../../lib/edge-sync.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const sql = getDb();
  const client = getClientInfo(req);

  try {
    // GET: list blocked IPs (and optionally force resync Edge Config)
    if (req.method === 'GET') {
      let syncResult = null;
      if (req.query?.sync === '1') {
        syncResult = await syncBlockedIpsToEdgeConfig();
      }

      const rows = await sql`
        SELECT
          id, ip_cidr::text AS ip_cidr, scope, reason, is_auto,
          blocked_by, blocked_hits::int, expires_at, created_at, updated_at,
          (expires_at IS NULL OR expires_at > NOW()) AS is_active
        FROM blocked_ips
        ORDER BY is_active DESC, updated_at DESC
        LIMIT 200
      `;

      return res.status(200).json({
        blocks: rows,
        currentIp: client.ip,
        edgeConfig: getEdgeConfigStatus(),
        syncResult
      });
    }

    // POST: add/update blocked IP or resync
    if (req.method === 'POST') {
      const body = await readJsonBody(req);

      if (body?.action === 'resync') {
        const syncResult = await syncBlockedIpsToEdgeConfig();
        return res.status(200).json({ ok: syncResult.synced, syncResult });
      }

      const normalizedCidr = isValidIpOrCidr(body?.ip_cidr || body?.ip);
      if (!normalizedCidr) {
        return res.status(400).json({
          error: 'Địa chỉ IP hoặc CIDR không hợp lệ (ví dụ hợp lệ: 113.161.10.5 hoặc 113.161.10.0/24).'
        });
      }

      // Self-lockout protection: prevent admin from blocking their own active IP
      if (isIpInCidr(client.ip, normalizedCidr)) {
        return res.status(400).json({
          error: `Không thể tự chặn IP hiện tại của bạn (${client.ip}) để tránh tự khóa tài khoản Admin.`
        });
      }

      const scope = body?.scope === 'admin_only' ? 'admin_only' : 'site_wide';
      const reason = String(body?.reason || '').trim().slice(0, 240);
      const durationHours = body?.duration_hours === null || body?.duration_hours === '' || body?.duration_hours === undefined
        ? null
        : Number(body.duration_hours);

      let expiresAt = null;
      if (durationHours !== null) {
        if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 8760) {
          return res.status(400).json({ error: 'Thời hạn chặn không hợp lệ.' });
        }
        expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
      }

      const inserted = await sql`
        INSERT INTO blocked_ips (ip_cidr, scope, reason, is_auto, blocked_by, expires_at, updated_at)
        VALUES (${normalizedCidr}::cidr, ${scope}, ${reason}, FALSE, ${admin.username}, ${expiresAt}::timestamptz, NOW())
        ON CONFLICT (ip_cidr) DO UPDATE SET
          scope = EXCLUDED.scope,
          reason = EXCLUDED.reason,
          is_auto = FALSE,
          blocked_by = EXCLUDED.blocked_by,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
        RETURNING id, ip_cidr::text AS ip_cidr, scope, reason, expires_at, created_at, updated_at
      `;

      const syncResult = await syncBlockedIpsToEdgeConfig();

      return res.status(200).json({
        ok: true,
        block: inserted[0],
        syncResult
      });
    }

    // DELETE: unblock IP by id or ip_cidr
    if (req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const id = Number(req.query?.id || body?.id || 0);
      const ipRaw = req.query?.ip || body?.ip_cidr || body?.ip;

      if (id > 0) {
        await sql`DELETE FROM blocked_ips WHERE id = ${id}`;
      } else if (ipRaw) {
        const cidr = isValidIpOrCidr(ipRaw);
        if (!cidr) return res.status(400).json({ error: 'IP cần gỡ chặn không hợp lệ.' });
        await sql`DELETE FROM blocked_ips WHERE ip_cidr = ${cidr}::cidr`;
      } else {
        return res.status(400).json({ error: 'Thiếu id hoặc địa chỉ IP cần gỡ chặn.' });
      }

      const syncResult = await syncBlockedIpsToEdgeConfig();
      return res.status(200).json({ ok: true, syncResult });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/admin/blocks]', err);
    return res.status(500).json({ error: err?.message || 'Lỗi xử lý danh sách chặn IP.' });
  }
}
