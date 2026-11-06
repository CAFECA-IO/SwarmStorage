import { useEffect, useRef, useState } from 'react';
import { MoreIcon } from '@/components/icons';

export interface IFileAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface IFileActionsMenuProps {
  filename: string;
  actions: IFileAction[];
  highlighted?: boolean;
}

/**
 * Info: (20261106 - Luphia)
 * 檔案的 ⋯ 選單 (開啟、下載、複製連結、下載權限、刪除)
 * Esc 或點擊外部關閉，方向鍵切換項目
 */
export default function FileActionsMenu({ filename, actions, highlighted }: IFileActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

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
    itemsRef.current[0]?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const moveFocus = (index: number) => {
    const count = actions.length;
    itemsRef.current[(index + count) % count]?.focus();
  };

  return (
    <div ref={rootRef} className="relative" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} role="presentation">
      <button
        type="button"
        aria-label={`More actions for ${filename}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${open || highlighted ? 'border-blue-500 bg-blue-950 text-white' : 'border-white/10 text-slate-300 hover:bg-white/5'}`}
      >
        <MoreIcon className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${filename}`}
          className="absolute right-0 top-11 z-30 w-52 rounded-xl border border-white/10 bg-slate-900 p-1.5 shadow-2xl shadow-black/60"
        >
          {actions.map((action, index) => (
            <button
              key={action.label}
              ref={el => {
                itemsRef.current[index] = el;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  moveFocus(index + 1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  moveFocus(index - 1);
                }
              }}
              className={`block w-full rounded-lg px-2.5 py-2 text-left text-[13px] focus:outline-none ${action.danger ? 'mt-1 border-t border-white/10 text-red-300 hover:bg-red-950/50 focus:bg-red-950/50' : 'text-slate-200 hover:bg-white/5 focus:bg-white/10'}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
