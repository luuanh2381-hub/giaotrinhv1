import { getAdminFromRequest } from '../../lib/auth.js';
import { getClientInfo } from '../../lib/ip-match.js';
import { getEdgeConfigStatus } from '../../lib/edge-sync.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(200).json({ authenticated: false });
  }

  const client = getClientInfo(req);
  return res.status(200).json({
    authenticated: true,
    user: {
      username: admin.username,
      role: admin.role
    },
    currentIp: client.ip,
    edgeConfig: getEdgeConfigStatus()
  });
}
