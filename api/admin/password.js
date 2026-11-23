import { getDb, readJsonBody } from '../../lib/db.js';
import { requireAdmin, verifyPassword, hashPassword } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const body = await readJsonBody(req);
    const currentPassword = String(body?.currentPassword || '');
    const newPassword = String(body?.newPassword || '');

    if (!currentPassword || newPassword.length < 8) {
      return res.status(400).json({
        error: 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới tối thiểu 8 ký tự.'
      });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT id, password_hash FROM admin_users WHERE username = ${admin.username} LIMIT 1
    `;
    const user = rows[0];
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
    }

    const newHash = await hashPassword(newPassword);
    await sql`
      UPDATE admin_users
      SET password_hash = ${newHash}, updated_at = NOW()
      WHERE id = ${user.id}
    `;

    return res.status(200).json({ ok: true, message: 'Đổi mật khẩu Admin thành công.' });
  } catch (err) {
    console.error('[api/admin/password]', err);
    return res.status(500).json({ error: 'Không thể đổi mật khẩu.' });
  }
}
