import { useCallback, useEffect, useState } from 'react';
import { ApiCode } from '@/lib/status';
import { memberHeaders } from '@/lib/member';
import {
  CafecaSignInError,
  openSignInPopup,
  signInWithPopup,
  signInWithRedirect,
  takeRedirectResult,
  type ICafecaNonce,
} from '@/lib/cafeca_client';

export interface IAuthUser {
  account: string;
  handle: string | null;
}

const REQUEST = { statement: 'Sign in to DropHere', claims: ['handle'] };

async function fetchNonce(): Promise<ICafecaNonce & { wallet: string }> {
  const res = await fetch('/api/v1/auth/cafeca/nonce', { method: 'POST' });
  const data = await res.json();
  if (data.code !== ApiCode.OK) throw new CafecaSignInError('nonce', data.message || 'Sign-in is not available right now.');
  return data.payload;
}

async function submitLogin(response: unknown) {
  const res = await fetch('/api/v1/auth/cafeca/login', {
    method: 'POST',
    // Info: (20261108 - Luphia) 附上瀏覽器金鑰，讓伺服器把這台瀏覽器匿名建立的房間與檔案併入帳戶
    headers: memberHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(response),
  });
  const data = await res.json();
  if (data.code !== ApiCode.OK) throw new CafecaSignInError('verify', data.message || 'Sign-in could not be verified.');
}

/**
 * Info: (20261108 - Luphia)
 * 以 CAFECA 登入 (選用)：登入或登出後重新載入頁面，讓房間、聊天與通話改用新的身分
 */
export function useAuth() {
  const [enabled, setEnabled] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [user, setUser] = useState<IAuthUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Info: (20261108 - Luphia) 整頁導向登入回來：先完成登入再讀取狀態
      const redirected = takeRedirectResult();
      if (redirected && 'response' in redirected) {
        try {
          setBusy(true);
          await submitLogin(redirected.response);
          window.location.reload();
          return;
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : 'Sign-in failed');
        } finally {
          if (!cancelled) setBusy(false);
        }
      } else if (redirected && 'error' in redirected && !cancelled) {
        setError(redirected.error.message);
      }
      try {
        const res = await fetch('/api/v1/auth/session', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled || data.code !== ApiCode.OK) return;
        setEnabled(!!data.payload.enabled);
        setWallet(data.payload.wallet);
        setUser(data.payload.user);
      } catch {
        // Info: (20261108 - Luphia) 讀不到登入狀態時維持匿名
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Info: (20261108 - Luphia) 必須在點擊事件中呼叫 (先同步開啟視窗，避免被瀏覽器擋下)
  const signIn = useCallback(() => {
    if (!wallet || busy) return;
    setError('');
    setBusy(true);
    const popup = openSignInPopup();
    const run = async () => {
      try {
        const nonce = await fetchNonce();
        if (!popup) {
          signInWithRedirect(nonce.wallet, nonce, REQUEST);
          return;
        }
        const response = await signInWithPopup(popup, nonce.wallet, nonce, REQUEST);
        await submitLogin(response);
        window.location.reload();
      } catch (err) {
        popup?.close();
        if (!(err instanceof CafecaSignInError && err.code === 'closed')) {
          setError(err instanceof Error ? err.message : 'Sign-in failed');
        }
        setBusy(false);
      }
    };
    run();
  }, [busy, wallet]);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/v1/auth/session', { method: 'DELETE' });
    } finally {
      window.location.reload();
    }
  }, []);

  return { enabled, user, busy, error, clearError: useCallback(() => setError(''), []), signIn, signOut };
}
