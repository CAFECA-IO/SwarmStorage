import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/use_auth';

const shortAccount = (account: string) => `${account.slice(0, 6)}…${account.slice(-4)}`;

// Info: (20261108 - Luphia) 一般的身分圖示 (不使用 CAFECA 商標)
function KeyIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 9.3-9.3" />
      <path d="m16 7 3 3" />
      <path d="m19 4 2 2" />
    </svg>
  );
}

/**
 * Info: (20261108 - Luphia)
 * 以 CAFECA 登入 (選用)：未登入時顯示登入按鈕；登入後顯示代稱 (或帳戶地址) 與登出
 * 伺服器未啟用 CAFECA 登入時不顯示
 */
export default function AccountButton({ compact = false }: { compact?: boolean }) {
  const { enabled, user, busy, error, clearError, signIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!enabled) return null;

  if (!user) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className={`inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 font-semibold text-slate-100 hover:bg-white/5 disabled:opacity-60 ${compact ? 'h-10 w-full px-3 text-xs' : 'h-10 px-4 text-[13px]'}`}
        >
          <KeyIcon className="h-4 w-4 text-amber-300" />
          {busy ? 'Signing in…' : 'Sign in with CAFECA'}
        </button>
        {error && (
          <p role="alert" className="absolute right-0 top-12 z-30 w-64 rounded-lg border border-red-500/30 bg-slate-900 px-3 py-2 text-xs text-red-300 shadow-xl">
            {error}{' '}
            <button type="button" onClick={clearError} className="font-semibold text-red-200 underline">
              Dismiss
            </button>
          </p>
        )}
      </div>
    );
  }

  const label = user.handle ? `@${user.handle}` : shortAccount(user.account);
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 font-semibold text-emerald-100 hover:bg-emerald-500/15 ${compact ? 'h-10 w-full justify-center px-3 text-xs' : 'h-10 px-3.5 text-[13px]'}`}
      >
        <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
        <span className="max-w-[160px] truncate">{label}</span>
      </button>
      {open && (
        <div role="menu" className={`absolute z-30 w-60 rounded-xl border border-white/10 bg-slate-900 p-1.5 shadow-2xl shadow-black/60 ${compact ? 'bottom-12 left-0' : 'right-0 top-12'}`}>
          <p className="px-2.5 py-2 text-[11px] leading-4 text-slate-400">
            Signed in with CAFECA
            <span className="mt-0.5 block break-all font-mono text-[10px] text-slate-500">{user.account}</span>
          </p>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={signOut}
            className="block w-full rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-200 hover:bg-white/5 focus:bg-white/10 focus:outline-none"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
