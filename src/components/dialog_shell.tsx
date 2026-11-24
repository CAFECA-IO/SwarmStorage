import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Info: (20261124 - Luphia)
 * 對話框外框 (房間設定、付費房解鎖)：
 * - 桌面版置中；手機版 'full' 佔滿畫面、'sheet' 從底部滑出
 * - Esc 或點背景關閉；開啟時把焦點移進對話框、背景不捲動，關閉後焦點回到原本的按鈕
 */

interface IDialogShellProps {
  label: string;
  onClose: () => void;
  mobile: 'full' | 'sheet';
  className: string;
  children: ReactNode;
}

export default function DialogShell({ label, onClose, mobile, className, children }: IDialogShellProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      // Info: (20261124 - Luphia) Tab 留在對話框內
      if (e.key === 'Tab' && boxRef.current) {
        const focusable = boxRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === boxRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  const position =
    mobile === 'full'
      ? 'inset-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[20px] sm:border'
      : 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[22px] border-t pb-[env(safe-area-inset-bottom)] sm:inset-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[90dvh] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[20px] sm:border sm:pb-0';

  return createPortal(
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-slate-950/75" aria-hidden="true" onClick={onClose} />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`absolute flex flex-col overflow-hidden border-slate-700 bg-[#0F172A] shadow-2xl shadow-black/60 outline-none ${position} ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
