import { getDb } from './db.js';

export function resolveEdgeConfigId() {
  const explicit = process.env.GLOBAL_CONFIG_ID || process.env.EDGE_CONFIG_ID;
  if (explicit) return explicit.trim();

  const conn = process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG || '';
  if (!conn) return '';

  try {
    const parsed = new URL(conn);
    const seg = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    if (seg) return seg;
  } catch {
    // Fallback regex if connection string is not a standard URL
  }
  const match = conn.match(/(?:ecfg|gcfg)_[a-zA-Z0-9]+/);
  return match ? match[0] : '';
}

export function getEdgeConfigStatus() {
  const edgeConfigId = resolveEdgeConfigId();
  const hasReadUrl = Boolean(process.env.GLOBAL_CONFIG || process.env.EDGE_CONFIG);
  const hasWriteToken = Boolean(process.env.VERCEL_API_TOKEN);
  return {
    configured: Boolean(edgeConfigId && hasReadUrl && hasWriteToken),
    hasReadUrl,
    hasWriteToken,
    edgeConfigId: edgeConfigId || null
  };
}

/**
 * Reads all active blocked_ips from Neon and pushes a compact snapshot
 * to Vercel Global Config (formerly Edge Config) under key "blocked_ips"
 * so Edge Middleware can block site-wide traffic in ~1ms with zero Neon queries.
 */
export async function syncBlockedIpsToEdgeConfig() {
  const status = getEdgeConfigStatus();
  if (!status.configured) {
    return {
      synced: false,
      reason: 'Chưa cấu hình đầy đủ GLOBAL_CONFIG (hoặc EDGE_CONFIG) và VERCEL_API_TOKEN trên Vercel.'
    };
  }

  const sql = getDb();
  const activeRows = await sql`
    SELECT ip_cidr::text AS cidr, scope, reason, expires_at
    FROM blocked_ips
    WHERE expires_at IS NULL OR expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1000
  `;

  const payload = activeRows.map(r => ({
    cidr: r.cidr,
    scope: r.scope || 'site_wide',
    reason: r.reason || '',
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null
  }));

  const teamQuery = process.env.VERCEL_TEAM_ID
    ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID.trim())}`
    : '';
  const endpoint = `https://api.vercel.com/v1/edge-config/${encodeURIComponent(status.edgeConfigId)}/items${teamQuery}`;

  const resp = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_API_TOKEN.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      items: [
        {
          operation: 'upsert',
          key: 'blocked_ips',
          value: payload
        }
      ]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return {
      synced: false,
      count: payload.length,
      reason: `Vercel Global Config API lỗi (${resp.status}): ${errText.slice(0, 200)}`
    };
  }

  return { synced: true, count: payload.length };
}
