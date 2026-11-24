import { useState, type ReactNode } from 'react';
import DialogShell from '@/components/dialog_shell';
import RoomSettingsPanel from '@/components/room_settings_panel';
import RoomPlanPanel from '@/components/room_plan_panel';
import { BoxIcon, ChevronLeftIcon, ChevronRightIcon, GearIcon, KeyIcon, SaleIcon, SlidersIcon, XIcon } from '@/components/icons';
import type { ILariaMetadata } from '@/lib/file_operator';
import type { IRoomSettings } from '@/lib/room_store';
import { DAY_MS, GB, formatAmount } from '@/lib/pay_plans';

/**
 * Info: (20261124 - Luphia)
 * 房間設定 (A：齒輪按鈕開啟的對話框；聊天欄不再放設定)
 * - 房主：General、Access、Plan & storage、Sell access (付款功能開啟時)
 * - 其他人：Plan & storage (任何人都可以替房間延長)
 * - 桌面版左側分類、右側內容；手機版先列出分類，點進去看內容
 */

export type TSettingsSection = 'general' | 'access' | 'plan' | 'sell';

interface IRoomSettingsDialogProps {
  roomId: string;
  password: string | null;
  settings: IRoomSettings;
  files: ILariaMetadata[];
  now: number;
  saving: boolean;
  error: string;
  // Info: (20261124 - Luphia) 指定分類開啟 (例如點到期時間)；沒有指定時手機版先顯示分類清單
  initialSection: TSettingsSection | null;
  onChange: (patch: Record<string, unknown>) => void;
  onChanged: () => void;
  onClose: () => void;
}

const gbText = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

export function settingsSections(settings: IRoomSettings): TSettingsSection[] {
  const payOn = !!settings.pay?.enabled;
  if (settings.isOwner) return payOn ? ['general', 'access', 'plan', 'sell'] : ['general', 'access'];
  return payOn && settings.pay?.access === 'full' ? ['plan'] : [];
}

function sectionInfo(id: TSettingsSection, settings: IRoomSettings, now: number): { title: string; icon: ReactNode; summary: string; intro: string } {
  const pay = settings.pay;
  switch (id) {
    case 'general':
      return {
        title: 'General',
        icon: <SlidersIcon className="h-4 w-4" />,
        summary: `${settings.listed ? 'On home page' : 'Hidden from home page'} · ${settings.uploadPolicy === 'everyone' ? 'everyone uploads' : 'owner uploads only'}`,
        intro: 'Name, who can upload and download, and how long files are kept.',
      };
    case 'access':
      return {
        title: 'Access',
        icon: <KeyIcon className="h-4 w-4" />,
        summary: settings.hasPassword ? 'Password set' : 'No password',
        intro: 'Who can enter the room. You never need the password.',
      };
    case 'plan': {
      const left = settings.expiresAt ? Math.max(0, Math.floor((settings.expiresAt - now) / DAY_MS)) : null;
      return {
        title: 'Plan & storage',
        icon: <BoxIcon className="h-4 w-4" />,
        summary: `${pay ? `${gbText(pay.usedBytes)} of ${gbText(pay.plan.capacityBytes)}` : 'Storage'}${left !== null ? ` · ${left === 1 ? '1 day' : `${left} days`} left` : ''}`,
        intro: 'Keep the room longer and get more space. Anyone in the room can extend it; DropHere pays the network fee.',
      };
    }
    case 'sell':
      return {
        title: 'Sell access',
        icon: <SaleIcon className="h-4 w-4" />,
        summary: pay?.paid ? `Selling · ${formatAmount(pay.paid.price)} USDC` : 'Not selling',
        intro: 'Visitors pay you directly in USDC on Solana. DropHere keeps 10% and pays the network fee.',
      };
  }
}

export default function RoomSettingsDialog({ roomId, password, settings, files, now, saving, error, initialSection, onChange, onChanged, onClose }: IRoomSettingsDialogProps) {
  const sections = settingsSections(settings);
  const [active, setActive] = useState<TSettingsSection>(initialSection && sections.includes(initialSection) ? initialSection : sections[0] ?? 'plan');
  // Info: (20261124 - Luphia) 手機版：分類清單 / 單一分類
  const [listMode, setListMode] = useState(!initialSection);
  const current = sections.includes(active) ? active : sections[0];
  if (!current) return null;
  const info = sectionInfo(current, settings, now);
  const selling = !!settings.pay?.paid;

  return (
    <DialogShell label="Room settings" onClose={onClose} mobile="full" className="sm:h-[min(720px,92dvh)] sm:w-[min(920px,calc(100vw-48px))] sm:flex-row">
      <nav aria-label="Settings sections" className={`${listMode ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col gap-1 overflow-y-auto bg-[#0B1222] p-3 sm:flex sm:w-[230px] sm:flex-none sm:border-r sm:border-white/10`}>
        <div className="flex items-center gap-2 px-2 pb-3 pt-1">
          <GearIcon className="h-[18px] w-[18px] text-slate-300" />
          <h2 className="flex-1 text-[15px] font-bold text-white">Room settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 sm:hidden">
            <XIcon className="h-5 w-5 text-slate-400" />
          </button>
        </div>
        {sections.map(id => {
          const item = sectionInfo(id, settings, now);
          const on = id === current;
          return (
            <button
              key={id}
              type="button"
              aria-current={on ? 'page' : undefined}
              onClick={() => {
                setActive(id);
                setListMode(false);
              }}
              className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm sm:py-2.5 ${on ? 'sm:bg-slate-800 sm:text-white' : 'sm:text-slate-400 sm:hover:bg-white/5 sm:hover:text-slate-200'} border border-white/10 text-slate-100 sm:border-transparent`}
            >
              <span className={id === 'sell' && selling ? 'text-violet-300' : 'text-slate-400'}>{item.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block">{item.title}</span>
                <span className={`block truncate text-xs sm:hidden ${id === 'sell' && selling ? 'text-violet-300' : 'text-slate-400'}`}>{item.summary}</span>
              </span>
              {id === 'sell' && selling && <span className="hidden h-2 w-2 rounded-full bg-violet-400 sm:block" aria-hidden="true" />}
              <ChevronRightIcon className="h-4 w-4 text-slate-500 sm:hidden" />
            </button>
          );
        })}
        <span className="flex-1" />
        <p className="px-3 py-2 text-[11px] text-slate-500">{settings.isOwner ? 'Only you see these settings' : 'Anyone in the room can extend it'}</p>
      </nav>

      <section aria-labelledby="settings-section-title" className={`${listMode ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-1 flex-col sm:flex`}>
        <div className="flex items-start gap-2 border-b border-white/10 px-4 py-3 sm:border-0 sm:px-8 sm:pb-2 sm:pt-6">
          {sections.length > 1 && (
            <button type="button" onClick={() => setListMode(true)} aria-label="All settings" className="-ml-1 rounded-lg p-1.5 text-slate-300 hover:bg-white/5 sm:hidden">
              <ChevronLeftIcon className="h-5 w-5" />
            </button>
          )}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id="settings-section-title" className="text-lg font-bold text-white">
              {info.title}
            </h2>
            <p className="mt-1 text-[13px] text-slate-400">{info.intro}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5">
            <XIcon className="h-5 w-5 text-slate-400" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:pt-3">
          {current === 'general' || current === 'access' ? (
            <RoomSettingsPanel key={`${current}:${settings.name}`} section={current} settings={settings} saving={saving} error={error} onChange={onChange} />
          ) : (
            <RoomPlanPanel section={current} roomId={roomId} password={password} settings={settings} files={files} now={now} onChanged={onChanged} />
          )}
        </div>
      </section>
    </DialogShell>
  );
}
