import { useState, type FormEvent } from 'react';
import ToggleSwitch from '@/components/toggle_switch';
import RoomSharePanel from '@/components/room_share_panel';
import { RETENTION_OPTIONS } from '@/components/room_create_form';
import type { IRoomSettings } from '@/lib/room_store';

interface IRoomSettingsPanelProps {
  settings: IRoomSettings;
  saving: boolean;
  error: string;
  onChange: (patch: Record<string, unknown>) => void;
}

/**
 * Info: (20261106 - Luphia)
 * 房間設定 (僅房主可見)：名稱、公開、上傳權限、預設下載、密碼、延長保存
 */
export default function RoomSettingsPanel({ settings, saving, error, onChange }: IRoomSettingsPanelProps) {
  const [name, setName] = useState(settings.name);
  const [password, setPassword] = useState('');

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== settings.name) onChange({ name: name.trim() });
  };

  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    onChange({ password });
    setPassword('');
  };

  return (
    <div className="flex flex-col gap-6 p-5">
      <section className="flex flex-col gap-2.5">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">Share</h2>
        <RoomSharePanel roomNumber={settings.roomNumber} />
      </section>

      <form onSubmit={saveName} className="flex flex-col gap-1.5">
        <label htmlFor="room-settings-name" className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
          Room name
        </label>
        <div className="flex gap-2">
          <input
            id="room-settings-name"
            aria-label="Room name"
            value={name}
            maxLength={60}
            onChange={e => setName(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 text-[13px] text-slate-100 outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            type="submit"
            disabled={saving || !name.trim() || name.trim() === settings.name}
            className="h-10 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>

      <section className="flex flex-col gap-1">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">Access</h2>
        <ToggleSwitch
          id="room-settings-listed"
          label="Show on home page"
          description={settings.listed ? 'Listed for everyone' : 'Hidden: join by number or link only'}
          checked={settings.listed}
          disabled={saving}
          onChange={listed => onChange({ listed })}
        />
        <ToggleSwitch
          id="room-settings-upload"
          label="Others can upload"
          description={settings.uploadPolicy === 'everyone' ? 'Everyone in the room can add files' : 'Only you can add files'}
          checked={settings.uploadPolicy === 'everyone'}
          disabled={saving}
          onChange={everyone => onChange({ uploadPolicy: everyone ? 'everyone' : 'owner' })}
        />
        <ToggleSwitch
          id="room-settings-download"
          label="Allow downloads for new files"
          description="Each file can still be changed from its menu"
          checked={settings.allowDownload}
          disabled={saving}
          onChange={allowDownload => onChange({ allowDownload })}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">Password</h2>
        <p className="text-xs text-slate-400">
          {settings.hasPassword ? 'Visitors must enter a password. The room still shows a lock in the list.' : 'Anyone with the number or link can enter.'}
        </p>
        <form onSubmit={savePassword} className="flex gap-2">
          <label htmlFor="room-settings-password" className="sr-only">
            New password
          </label>
          <input
            id="room-settings-password"
            aria-label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            maxLength={128}
            placeholder={settings.hasPassword ? 'New password' : 'Set a password'}
            onChange={e => setPassword(e.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-3 text-[13px] text-slate-100 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            type="submit"
            disabled={saving || !password}
            className="h-10 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40"
          >
            {settings.hasPassword ? 'Change' : 'Set'}
          </button>
        </form>
        {settings.hasPassword && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onChange({ password: null })}
            className="self-start text-xs font-semibold text-red-300 hover:text-red-200"
          >
            Remove password
          </button>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase" id="room-settings-keep">
          Keep files for (from now)
        </h2>
        <div className="grid grid-cols-4 gap-1.5" role="group" aria-labelledby="room-settings-keep">
          {RETENTION_OPTIONS.map(option => (
            <button
              key={option.minutes}
              type="button"
              disabled={saving}
              aria-pressed={settings.minutes === option.minutes}
              onClick={() => onChange({ minutes: option.minutes })}
              className={`h-10 rounded-xl text-[13px] ${settings.minutes === option.minutes ? 'bg-blue-600 font-semibold text-white' : 'border border-white/10 text-slate-300 hover:bg-white/5'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
