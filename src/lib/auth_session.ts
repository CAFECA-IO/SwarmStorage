import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/**
 * Info: (20261108 - Luphia)
 * 以 CAFECA 登入後的 session：簽章 cookie (HMAC-SHA256)，伺服器不保存 session 狀態
 * - 內容只有 CAFECA 身分合約地址、代稱與到期時間
 * - 簽章金鑰：SESSION_SECRET，未設定時自動產生並保存在 .drophere/session.key (重新部署沿用)
 * - 洩漏時更換金鑰即可讓所有 session 失效
 */

export const SESSION_COOKIE = 'drophere_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SECRET_FILE = path.join(process.cwd(), '.drophere', 'session.key');

export interface ISession {
  // Info: (20261108 - Luphia) 身分合約地址 (小寫)，就是使用者在 DropHere 的唯一 ID
  account: string;
  // Info: (20261108 - Luphia) CAFECA 代稱 (使用者同意提供時才有)
  handle: string | null;
  expiresAt: number;
}

let cachedSecret: Buffer | null = null;

function sessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    cachedSecret = Buffer.from(fromEnv, 'utf-8');
    return cachedSecret;
  }
  try {
    const stored = readFileSync(SECRET_FILE, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/.test(stored)) {
      cachedSecret = Buffer.from(stored, 'hex');
      return cachedSecret;
    }
  } catch {
    // Info: (20261108 - Luphia) 第一次啟動：產生新的金鑰
  }
  const created = randomBytes(32).toString('hex');
  mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(SECRET_FILE, created, { mode: 0o600, flag: 'wx' });
    cachedSecret = Buffer.from(created, 'hex');
  } catch {
    // Info: (20261108 - Luphia) 同時有其他請求先建立了金鑰：改用已存在的那一把
    cachedSecret = Buffer.from(readFileSync(SECRET_FILE, 'utf-8').trim(), 'hex');
  }
  return cachedSecret;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const sign = (payload: string) => createHmac('sha256', sessionSecret()).update(payload).digest();

export function encodeSession(account: string, handle: string | null): { value: string; maxAge: number } {
  const body: ISession = { account: account.toLowerCase(), handle, expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payload = b64url(Buffer.from(JSON.stringify(body), 'utf-8'));
  return { value: `${payload}.${b64url(sign(payload))}`, maxAge: SESSION_TTL_SECONDS };
}

export function decodeSession(value: string | null | undefined): ISession | null {
  if (!value) return null;
  const [payload, mac] = value.split('.');
  if (!payload || !mac) return null;
  try {
    const expected = sign(payload);
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as ISession;
    if (typeof body.account !== 'string' || !/^0x[0-9a-f]{40}$/.test(body.account)) return null;
    if (typeof body.expiresAt !== 'number' || body.expiresAt <= Date.now() / 1000) return null;
    const handle = typeof body.handle === 'string' && /^[a-z0-9_]{3,20}$/.test(body.handle) ? body.handle : null;
    return { account: body.account, handle, expiresAt: body.expiresAt };
  } catch {
    return null;
  }
}

const readCookie = (headers: Headers, name: string): string | null => {
  const raw = headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
};

export const sessionFromHeaders = (headers: Headers): ISession | null => decodeSession(readCookie(headers, SESSION_COOKIE));

export { readCookie };

// Info: (20261108 - Luphia) 登入者的成員身分雜湊：與瀏覽器金鑰的雜湊格式相同 (64 hex)，但不會重疊
export const accountMemberHash = (account: string): string =>
  createHash('sha256').update(`cafeca:${account.toLowerCase()}`).digest('hex');

// Info: (20261108 - Luphia) session cookie 屬性：只限 HTTP 讀取、同站送出；HTTPS 時加上 Secure
export function sessionCookieOptions(secure: boolean, maxAge: number) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge };
}
