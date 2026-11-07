/**
 * Info: (20261108 - Luphia)
 * Sign in with CAFECA 的瀏覽器端流程 (依 CAFECA 官方 cafeca-connect.js v1 協定)：
 * - popup：在點擊事件中開啟錢包視窗，錢包以 postMessage 把結果送回本站 (只接受錢包 origin、且是我們開的視窗)
 * - redirect：彈出視窗被擋時整頁導向錢包，結果放在網址 #cafeca= (不會送到任何伺服器)
 * 前端拿到的結果一律交給後端驗證，前端不做任何信任判斷
 */

const VERSION = 1;
const POPUP_NAME = 'cafeca-signin';

export interface ICafecaNonce {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ICafecaRequestOptions {
  statement?: string;
  claims?: string[];
}

export class CafecaSignInError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const b64url = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach(b => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64url = (text: string) => {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
};

const pageUri = () => window.location.href.split('#')[0];

function authLink(wallet: string, n: ICafecaNonce, mode: 'popup' | 'redirect', options: ICafecaRequestOptions) {
  const request: Record<string, unknown> = {
    v: VERSION,
    domain: window.location.origin,
    uri: pageUri(),
    nonce: n.nonce,
    issuedAt: n.issuedAt,
    expiresAt: n.expiresAt,
    mode,
  };
  if (options.statement) request.statement = options.statement.slice(0, 200);
  if (options.claims?.length) request.claims = options.claims;
  if (mode === 'redirect') request.redirectUri = pageUri();
  return `${new URL(wallet).origin}/dl/auth?v=1&req=${b64url(JSON.stringify(request))}`;
}

// Info: (20261108 - Luphia) 必須在點擊事件中同步呼叫，否則會被瀏覽器擋下；被擋時回傳 null
export function openSignInPopup(): Window | null {
  const width = 420;
  const height = 720;
  const left = (window.screenX || 0) + Math.max(0, ((window.outerWidth || width) - width) / 2);
  const top = (window.screenY || 0) + Math.max(0, ((window.outerHeight || height) - height) / 2);
  return window.open('about:blank', POPUP_NAME, `popup,width=${width},height=${height},left=${left},top=${top}`);
}

export function signInWithPopup(popup: Window, wallet: string, n: ICafecaNonce, options: ICafecaRequestOptions): Promise<unknown> {
  const walletOrigin = new URL(wallet).origin;
  popup.location.href = authLink(wallet, n, 'popup', options);
  return new Promise((resolve, reject) => {
    const finish = (result: unknown, error: CafecaSignInError | null) => {
      clearInterval(closedTimer);
      clearTimeout(limit);
      window.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== walletOrigin || event.source !== popup) return;
      const data = event.data as { type?: string; v?: number; error?: string; nonce?: string; message?: { nonce?: string } } | null;
      if (!data || data.type !== 'cafeca:auth' || data.v !== VERSION) return;
      if (data.error) {
        if (data.nonce && data.nonce !== n.nonce) return;
        finish(null, new CafecaSignInError(data.error, data.error === 'access_denied' ? 'Sign-in was cancelled.' : 'The sign-in request was rejected.'));
        return;
      }
      if (data.message?.nonce !== n.nonce) return;
      finish(data, null);
    };
    const closedTimer = setInterval(() => {
      if (popup.closed) finish(null, new CafecaSignInError('closed', 'The CAFECA window was closed.'));
    }, 400);
    const limit = setTimeout(
      () => finish(null, new CafecaSignInError('timeout', 'Sign-in timed out.')),
      Math.max(10, n.expiresAt - Math.floor(Date.now() / 1000) + 5) * 1000
    );
    window.addEventListener('message', onMessage);
  });
}

export function signInWithRedirect(wallet: string, n: ICafecaNonce, options: ICafecaRequestOptions) {
  window.location.assign(authLink(wallet, n, 'redirect', options));
}

/**
 * Info: (20261108 - Luphia)
 * 整頁導向回來後讀取 #cafeca= 的結果並清除網址列；沒有結果時回傳 null
 */
export function takeRedirectResult(): { response: unknown } | { error: CafecaSignInError } | null {
  const match = /(?:^#|&)cafeca=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    const data = JSON.parse(unb64url(match[1])) as { type?: string; error?: string };
    if (!data || data.type !== 'cafeca:auth') return null;
    if (data.error) return { error: new CafecaSignInError(data.error, data.error === 'access_denied' ? 'Sign-in was cancelled.' : 'The sign-in request was rejected.') };
    return { response: data };
  } catch {
    return null;
  }
}
