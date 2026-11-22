import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import ToggleSwitch from '@/components/toggle_switch';
import { AlertIcon, BellIcon, ChartIcon, ExternalIcon, HourglassIcon, SaleIcon, XIcon } from '@/components/icons';
import { formatAmount } from '@/lib/pay_plans';
import type { TOwnerNotice } from '@/lib/owner_earnings';
import {
  claimToastHost,
  dismissToast,
  isToastHost,
  markAllSeen,
  releaseToastHost,
  setBrowserNotify,
  setSound,
  useOwnerNotices,
  type IOwnerNoticeState,
} from '@/lib/use_owner_notices';

/**
 * Info: (20261122 - Luphia)
 * 房主通知鈴鐺 (登入且用過付費功能才顯示)：
 * - 新銷售、昨日摘要、付費房即將停賣；關閉面板時標為已讀
 * - 新銷售時在畫面角落提示；分頁在背景時送出瀏覽器通知 (使用者開啟後)
 * - 手機版以底部面板顯示
 */

const txUrl = (signature: string) => `https://solscan.io/tx/${signature}`;
const roomUrl = (roomId: string) => `/room/${roomId}`;
const extendUrl = (roomId: string) => `/room/${roomId}?panel=plan`;

export function timeAgo(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const date = new Date(at);
  const today = new Date(now);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return `${Math.floor(diff / 3_600_000)} h ago`;
  const yesterday = new Date(now - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const dayLabel = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

type TTab = 'all' | 'sales' | 'rooms';

function NoticeRow({ notice, unread, onNavigate }: { notice: TOwnerNotice; unread: boolean; onNavigate: () => void }) {
  const base = `flex gap-3 border-l-[3px] px-4 py-3 text-[13px] ${unread ? 'border-emerald-500 bg-emerald-500/[0.06]' : 'border-transparent'}`;
  const iconBox = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg';
  if (notice.kind === 'sale') {
    return (
      <li className={base}>
        <span className={`${iconBox} bg-emerald-500/15 text-emerald-300`}>
          <SaleIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={roomUrl(notice.roomId)} onClick={onNavigate} className="block text-slate-100 hover:underline">
            <b className="font-semibold text-emerald-300">
              +{formatAmount(notice.amount)} {notice.token}
            </b>{' '}
            · {notice.buyerName ?? 'A guest'} bought access
          </Link>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {notice.roomName} · {timeAgo(notice.at)} ·{' '}
            <a href={txUrl(notice.signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-300 hover:underline">
              Solscan
              <ExternalIcon className="h-3 w-3" />
            </a>
          </p>
        </div>
      </li>
    );
  }
  if (notice.kind === 'summary') {
    return (
      <li className={base}>
        <span className={`${iconBox} bg-slate-800 text-slate-300`}>
          <ChartIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-slate-200">
            {dayLabel(notice.day)}: <b className="font-semibold">{notice.count === 1 ? '1 sale' : `${notice.count} sales`}</b>, you received{' '}
            <b className="font-semibold text-emerald-300">{formatAmount(notice.amount)}</b>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">Daily summary</p>
        </div>
      </li>
    );
  }
  const ending = notice.kind === 'ending';
  return (
    <li className={base}>
      <span className={`${iconBox} ${ending ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300'}`}>{ending ? <HourglassIcon className="h-4 w-4" /> : <AlertIcon className="h-4 w-4" />}</span>
      <div className="min-w-0 flex-1">
        <p className="text-slate-200">
          {notice.roomName} {ending ? (notice.days < 1 ? 'stops selling today' : `stops selling in ${notice.days === 1 ? '1 day' : `${notice.days} days`}`) : 'is not on sale'}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          {ending ? 'Paid rooms need 30+ days left' : 'Less than 30 days left'} ·{' '}
          <Link href={extendUrl(notice.roomId)} onClick={onNavigate} className="font-semibold text-blue-300 hover:underline">
            Extend
          </Link>
        </p>
      </div>
    </li>
  );
}

function NoticePanel({ notices, onClose }: { notices: IOwnerNoticeState; onClose: () => void }) {
  const [tab, setTab] = useState<TTab>('all');
  const list = notices.notices.filter(n => tab === 'all' || (tab === 'sales' ? n.kind === 'sale' || n.kind === 'summary' : n.kind === 'ending' || n.kind === 'stopped'));
  const { permission, prefs } = notices;
  const tabs: [TTab, string][] = [
    ['all', 'All'],
    ['sales', 'Sales'],
    ['rooms', 'Rooms'],
  ];
  return (
    <>
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <h2 className="flex-1 text-sm font-semibold text-white">Notifications</h2>
        {notices.unread > 0 && (
          <button type="button" onClick={markAllSeen} className="text-xs font-semibold text-blue-300 hover:underline">
            Mark all read
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close notifications" className="rounded-md p-1 text-slate-400 hover:bg-white/5 sm:hidden">
          <XIcon className="h-4 w-4" />
        </button>
      </div>
      <div className="flex gap-1.5 px-4 py-2.5" role="tablist" aria-label="Filter notifications">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-full px-3 py-1 text-xs ${tab === value ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="max-h-[min(360px,50dvh)] overflow-y-auto">
        {list.length === 0 ? (
          <li className="px-4 py-8 text-center text-[13px] text-slate-500">{tab === 'rooms' ? 'All your paid rooms have time left.' : 'No sales in the last 30 days yet.'}</li>
        ) : (
          list.map(n => <NoticeRow key={n.id} notice={n} unread={n.at > notices.seenAt} onNavigate={onClose} />)
        )}
      </ul>
      <div className="flex flex-col gap-1 border-t border-white/10 px-4 py-2.5">
        {permission === 'unsupported' ? (
          <p className="rounded-lg bg-slate-800/70 px-3 py-2 text-[11px] leading-4 text-slate-400">This browser can’t show notifications. On iPhone, add Drop Here to your Home Screen first.</p>
        ) : (
          <ToggleSwitch
            id="notify-browser"
            label="Browser notifications for sales"
            description={permission === 'denied' ? 'Blocked — allow notifications for this site in your browser settings' : 'When this tab is in the background'}
            checked={prefs.browser && permission === 'granted'}
            disabled={permission === 'denied'}
            onChange={setBrowserNotify}
          />
        )}
        <ToggleSwitch id="notify-sound" label="Sound" checked={prefs.sound} onChange={setSound} />
        <Link href="/earnings" onClick={onClose} className="py-1.5 text-center text-[13px] font-semibold text-blue-300 hover:underline">
          Open earnings →
        </Link>
      </div>
    </>
  );
}

function SaleToasts({ notices }: { notices: IOwnerNoticeState }) {
  if (notices.toasts.length === 0) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-3 top-3 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:top-auto sm:w-[360px]" aria-live="polite">
      {notices.toasts.map(t => (
        <div key={t.id} role="status" className="pointer-events-auto flex gap-3 rounded-2xl border border-emerald-500/60 bg-emerald-950 px-4 py-3 shadow-2xl shadow-black/60">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-emerald-950">
            <SaleIcon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="font-semibold text-white">
              New sale · +{formatAmount(t.amount)} {t.token}
            </p>
            <p className="truncate text-emerald-200">
              {t.buyerName ?? 'A guest'} unlocked {t.roomName}
            </p>
            <a href={txUrl(t.signature)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 hover:underline">
              View transaction
              <ExternalIcon className="h-3 w-3" />
            </a>
          </div>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="self-start rounded-md p-1 text-emerald-300 hover:bg-white/5">
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

export default function NotificationBell({ enabled, compact = false }: { enabled: boolean; compact?: boolean }) {
  const notices = useOwnerNotices(enabled, formatAmount);
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef(0);
  useEffect(() => {
    unreadRef.current = notices.unread;
  });

  useEffect(() => {
    if (!enabled) return;
    const id = claimToastHost();
    // Info: (20261122 - Luphia) 掛上後才登記 (伺服器端渲染時沒有 document)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHostId(id);
    return () => releaseToastHost(id);
  }, [enabled]);

  const close = () => {
    setOpen(false);
    if (unreadRef.current > 0) markAllSeen();
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!enabled || !notices.active) return null;
  const badge = notices.unread > 9 ? '9+' : String(notices.unread);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={notices.unread > 0 ? `Notifications, ${notices.unread} unread` : 'Notifications'}
        onClick={() => (open ? close() : setOpen(true))}
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${open ? 'border-blue-500/60 bg-blue-500/15 text-blue-100' : 'border-white/15 text-slate-200 hover:bg-white/5'}`}
      >
        <BellIcon className="h-[18px] w-[18px]" />
        {notices.unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-emerald-500 px-1 text-center text-[11px] font-bold leading-[18px] text-emerald-950" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-950/60 sm:hidden" aria-hidden="true" onClick={close} />
          <div
            role="dialog"
            aria-label="Notifications"
            className={`fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-2xl border-t border-white/15 bg-slate-900 pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/60 sm:inset-x-auto sm:w-[380px] sm:rounded-2xl sm:border sm:pb-0 ${compact ? 'sm:bottom-[112px] sm:left-4' : 'sm:absolute sm:bottom-auto sm:right-0 sm:top-12'}`}
          >
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-700 sm:hidden" aria-hidden="true" />
            <NoticePanel notices={notices} onClose={close} />
          </div>
        </>
      )}
      {isToastHost(hostId) && <SaleToasts notices={notices} />}
    </div>
  );
}
