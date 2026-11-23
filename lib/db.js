import { neon } from '@neondatabase/serverless';

let cachedSql = null;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL chưa được cấu hình trên Vercel Environment Variables.');
  }
  if (!cachedSql) {
    cachedSql = neon(url);
  }
  return cachedSql;
}

export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return req.body;
    }
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function vietnamDateStr(date = new Date()) {
  // UTC+7 date string YYYY-MM-DD
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return vnTime.toISOString().slice(0, 10);
}
