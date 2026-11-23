import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { getDb } from './db.js';
import { getHeader } from './ip-match.js';

export const SESSION_COOKIE_NAME = 'hsk_admin_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

function getJwtSecretBytes() {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('ADMIN_JWT_SECRET chưa được cấu hình (cần tối thiểu 16 ký tự).');
  }
  return new TextEncoder().encode(secret);
}

export async function signAdminToken(payload) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(getJwtSecretBytes());
}

export async function verifyAdminToken(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = getHeader(req?.headers, 'cookie');
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function setSessionCookie(res, token) {
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SEC}`
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export async function getAdminFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifyAdminToken(token);
}

export async function requireAdmin(req, res) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ error: 'Phiên đăng nhập Admin không hợp lệ hoặc đã hết hạn.' });
    return null;
  }
  return admin;
}

/**
 * Auto-bootstrap the very first Admin account from env vars if admin_users is empty.
 */
export async function ensureInitialAdmin() {
  const sql = getDb();
  const rows = await sql`SELECT COUNT(*)::int AS cnt FROM admin_users`;
  if ((rows[0]?.cnt || 0) > 0) return;

  const defaultUser = (process.env.ADMIN_DEFAULT_USER || 'admin').trim();
  const defaultPass = process.env.ADMIN_DEFAULT_PASSWORD;
  if (!defaultPass) {
    throw new Error('Bảng admin_users đang trống và chưa cấu hình ADMIN_DEFAULT_PASSWORD.');
  }
  const hash = await bcrypt.hash(defaultPass, 10);
  await sql`
    INSERT INTO admin_users (username, password_hash, role)
    VALUES (${defaultUser}, ${hash}, 'super_admin')
    ON CONFLICT (username) DO NOTHING
  `;
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
