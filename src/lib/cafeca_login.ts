import { randomBytes } from 'crypto';
import { createCafecaVerifier, newNonce, type SignInResponse } from '@/lib/cafeca/verify';

/**
 * Info: (20261108 - Luphia)
 * Sign in with CAFECA (https://github.com/CAFECA-IO/CAFECA)：
 * - 不需要向 CAFECA 註冊或 API key；使用者以 Passkey 簽署綁定本站網域的 EIP-712 訊息
 * - 本站以公開 RPC 呼叫使用者身分合約的 isValidSignature (ERC-1271) 自行驗證
 * - nonce 綁定瀏覽器 (httpOnly cookie)、只能使用一次、5 分鐘內有效
 */

export const LOGIN_COOKIE = 'drophere_login';
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 20000;

export interface ICafecaConfig {
  wallet: string;
  // Info: (20261108 - Luphia) 本站允許的 origin (使用者簽署的訊息必須是其中之一)
  origins: string[] | null;
}

export function getCafecaConfig(): ICafecaConfig | null {
  const wallet = (process.env.CAFECA_WALLET ?? 'https://cafeca.io').trim();
  if (!wallet || wallet === 'off') return null;
  const origins = (process.env.PUBLIC_ORIGIN ?? '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return { wallet: new URL(wallet).origin, origins: origins.length ? origins : null };
}

const isLocalOrigin = (origin: string) => {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

/**
 * Info: (20261108 - Luphia)
 * 這次登入應該綁定的網域：瀏覽器送出的 Origin，且必須在 PUBLIC_ORIGIN 名單內
 * 未設定 PUBLIC_ORIGIN 時只允許 localhost (開發用)，避免以偽造的 Host / Origin 讓仿冒網站的簽章通過
 */
export function expectedDomain(config: ICafecaConfig, requestOrigin: string | null): { ok: true; domain: string } | { ok: false; message: string } {
  if (!requestOrigin) return { ok: false, message: 'Missing Origin header' };
  if (config.origins) {
    return config.origins.includes(requestOrigin) ? { ok: true, domain: requestOrigin } : { ok: false, message: 'This site is not allowed to sign in' };
  }
  if (isLocalOrigin(requestOrigin)) return { ok: true, domain: requestOrigin };
  return { ok: false, message: 'Set PUBLIC_ORIGIN on the server to enable CAFECA sign-in' };
}

const globalForLogin = globalThis as unknown as {
  cafecaLogin?: {
    pending: Map<string, { nonce: string; domain: string; expiresAt: number }>;
    verifier: ReturnType<typeof createCafecaVerifier> | null;
    verifierKey: string;
  };
};
const state = (globalForLogin.cafecaLogin ??= { pending: new Map(), verifier: null, verifierKey: '' });

const purge = () => {
  const now = Date.now();
  state.pending.forEach((entry, id) => {
    if (entry.expiresAt <= now) state.pending.delete(id);
  });
};

// Info: (20261108 - Luphia) 產生 nonce 並綁定這個瀏覽器的登入嘗試 (cookie)
export function issueNonce(domain: string, attemptId: string | null) {
  purge();
  if (state.pending.size >= MAX_PENDING) return null;
  const id = attemptId && /^[A-Za-z0-9_-]{32}$/.test(attemptId) ? attemptId : randomBytes(24).toString('base64url');
  const nonce = newNonce();
  const expiresAt = Date.now() + NONCE_TTL_MS;
  state.pending.set(id, { nonce, domain, expiresAt });
  return { attemptId: id, nonce, issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(expiresAt / 1000) };
}

// Info: (20261108 - Luphia) 取出並作廢 nonce (不論驗證成功與否都只能用一次)
export function takeNonce(attemptId: string | null) {
  if (!attemptId) return null;
  const entry = state.pending.get(attemptId);
  state.pending.delete(attemptId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

const verifierFor = (config: ICafecaConfig) => {
  const key = `${config.wallet}|${process.env.CAFECA_RPC_URL ?? ''}`;
  if (!state.verifier || state.verifierKey !== key) {
    state.verifier = createCafecaVerifier({ wallet: config.wallet, rpcUrl: process.env.CAFECA_RPC_URL?.trim() || undefined });
    state.verifierKey = key;
  }
  return state.verifier;
};

export async function verifyCafecaLogin(config: ICafecaConfig, response: SignInResponse, domain: string, nonce: string) {
  const user = await verifierFor(config).verify(response, { domain, nonce });
  const handle = typeof user.claims.handle === 'string' && user.claims.handleVerified ? user.claims.handle : null;
  return { account: user.account.toLowerCase(), handle };
}
