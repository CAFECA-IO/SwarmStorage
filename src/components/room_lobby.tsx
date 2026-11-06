import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { IRoomSummary } from '@/lib/room_store';
import { ApiCode } from '@/lib/status';
import { formatBytes } from '@/lib/utils';
import { getRecentRooms, memberHeaders } from '@/lib/member';
import { EyeOffIcon, LockIcon, PlusIcon, UsersIcon, XIcon } from '@/components/icons';
import RoomCreateForm from '@/components/room_create_form';

type TFilter = 'all' | 'mine' | 'open';

const REFRESH_MS = 15000;

const formatExpiry = (ms: number | null): string => {
  if (ms === null) return 'No expiry';
  if (ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `Expires in ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Expires in ${hours} h`;
  return `Expires in ${Math.floor(hours / 24)} d`;
};

function PasswordBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-950 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-200">
      <LockIcon className="h-3 w-3" />
      PASSWORD
    </span>
  );
}

function RoomBadges({ room }: { room: IRoomSummary }) {
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {room.isOwner && (
        <span className="rounded-full bg-blue-950 px-2 py-0.5 text-[10px] font-bold tracking-wide text-blue-200">OWNER</span>
      )}
      {room.isOwner && !room.listed && (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold tracking-wide text-slate-300">
          <EyeOffIcon className="h-3 w-3" />
          HIDDEN
        </span>
      )}
      {room.hasPassword && <PasswordBadge />}
      {room.uploading > 0 && (
        <span className="rounded-full bg-blue-950 px-2 py-0.5 text-[10px] font-bold tracking-wide text-blue-200">UPLOADING</span>
      )}
    </span>
  );
}

const roomStats = (room: IRoomSummary) =>
  room.fileCount === null
    ? 'Files hidden until unlocked'
    : `${room.fileCount} file${room.fileCount === 1 ? '' : 's'} · ${formatBytes(room.totalSize ?? 0)}`;

/**
 * Info: (20261106 - Luphia)
 * 首頁：房間清單 (公開 + 自己的 + 最近造訪)、以房號加入、建立房間
 * - 桌面版 (V2)：房間卡片 + 右側建立表單
 * - 手機版 (V3)：快速加入 + 你的房間 + 公開房間，建立房間以三步驟底部面板進行
 */
export default function RoomLobby() {
  const router = useRouter();
  const [rooms, setRooms] = useState<IRoomSummary[] | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<TFilter>('all');
  const [joinNumber, setJoinNumber] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);

  const loadRooms = useCallback(async () => {
    try {
      const recentRooms = getRecentRooms();
      const res = await fetch(`/api/v1/room?include=${recentRooms.join(',')}`, { headers: memberHeaders() });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message);
      setRecent(recentRooms);
      setRooms(data.payload.rooms);
      setNow(data.payload.serverTime);
      setLoadError('');
    } catch {
      setLoadError('Could not load rooms. Retrying…');
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(loadRooms, 0);
    const timer = setInterval(loadRooms, REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [loadRooms]);

  const sorted = useMemo(() => {
    const score = (room: IRoomSummary) => (room.isOwner ? 2 : 0) + (recent.includes(room.roomNumber) ? 1 : 0);
    return [...(rooms || [])].sort(
      (a, b) => score(b) - score(a) || b.online - a.online || (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );
  }, [rooms, recent]);

  const isMine = (room: IRoomSummary) => room.isOwner || recent.includes(room.roomNumber);
  const mine = sorted.filter(isMine);
  const openForUploads = sorted.filter(r => r.uploadPolicy === 'everyone');
  const listedRooms = sorted.filter(r => r.listed);
  const visible = filter === 'mine' ? mine : filter === 'open' ? openForUploads : sorted;

  const enterRoom = (roomNumber: string) => router.push(`/room/${roomNumber}`);

  const handleJoin = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d{6}$/.test(joinNumber)) enterRoom(joinNumber);
  };

  const joinInput = (id: string, large = false) => (
    <form onSubmit={handleJoin} className="flex gap-2">
      <label htmlFor={id} className="sr-only">
        Room number
      </label>
      <input
        id={id}
        aria-label="Room number"
        inputMode="numeric"
        autoComplete="off"
        maxLength={6}
        value={joinNumber}
        onChange={e => setJoinNumber(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="000000"
        className={`min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-950 px-3 text-center font-mono text-slate-100 outline-none placeholder:text-slate-600 focus:ring-2 focus:ring-blue-500/40 ${large ? 'h-14 text-2xl tracking-[0.5em]' : 'h-11 text-base tracking-[0.35em]'}`}
      />
      <button
        type="submit"
        disabled={joinNumber.length !== 6}
        className={`shrink-0 rounded-xl bg-slate-800 px-4 text-sm font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-40 ${large ? 'h-14' : 'h-11'}`}
      >
        Join
      </button>
    </form>
  );

  const filters: [TFilter, string, number][] = [
    ['all', 'All', sorted.length],
    ['mine', 'Mine', mine.length],
    ['open', 'Open for uploads', openForUploads.length],
  ];

  return (
    <div className="min-h-dvh bg-slate-950 font-sans text-slate-100">
      {/* Info: (20261106 - Luphia) 桌面版 (V2) */}
      <div className="hidden min-h-dvh lg:flex">
        <main className="flex min-w-0 flex-1 flex-col gap-5 px-9 py-7">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Link href="/" className="text-xl font-bold text-blue-400">
                Drop Here
              </Link>
              <h1 className="mt-2.5 text-[26px] font-bold">Rooms</h1>
              <p className="mt-1 text-[13px] text-slate-400">Pick a room to enter, or create one on the right.</p>
            </div>
            <div className="flex gap-1.5" role="group" aria-label="Filter rooms">
              {filters.map(([value, label, count]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`h-[34px] rounded-full px-3.5 text-xs ${filter === value ? 'bg-blue-600 font-semibold text-white' : 'border border-white/10 text-slate-300 hover:bg-white/5'}`}
                >
                  {label} {count}
                </button>
              ))}
            </div>
          </header>

          {loadError && <p className="text-xs text-amber-300">{loadError}</p>}

          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
            {rooms === null &&
              [0, 1, 2].map(i => <div key={i} className="h-[178px] animate-pulse rounded-2xl border border-white/10 bg-[#0B1222]" />)}
            {visible.map(room => (
              <Link
                key={room.roomNumber}
                href={`/room/${room.roomNumber}`}
                className={`flex flex-col gap-3 rounded-2xl border bg-[#0B1222] p-[18px] transition-colors hover:bg-[#0F182C] focus-visible:outline-2 focus-visible:outline-blue-400 ${room.isOwner ? 'border-blue-800' : 'border-white/10'}`}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-mono text-xs text-slate-400">#{room.roomNumber}</span>
                  <RoomBadges room={room} />
                </span>
                <span className="text-base font-bold">{room.name}</span>
                <span className="flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded-md bg-slate-800 px-2 py-1 text-slate-300">
                    {room.uploadPolicy === 'everyone' ? 'Everyone uploads' : 'Owner uploads only'}
                  </span>
                </span>
                <span className="flex justify-between gap-2 text-xs text-slate-400">
                  <span>{roomStats(room)}</span>
                  <span className={`inline-flex items-center gap-1 ${room.online > 0 ? 'text-emerald-300' : ''}`}>
                    <UsersIcon className="h-3.5 w-3.5" />
                    {room.online > 0 ? `${room.online} here` : 'nobody here'}
                  </span>
                </span>
                <span className={`text-[11px] ${room.expiresAt && room.expiresAt - now < 3600000 ? 'text-amber-300' : 'text-slate-400'}`}>
                  {formatExpiry(room.expiresAt === null ? null : room.expiresAt - now)}
                </span>
              </Link>
            ))}
            <div className="flex flex-col justify-center gap-2.5 rounded-2xl border border-dashed border-slate-700 p-[18px]">
              <span className="text-[13px] font-semibold">Have a room number?</span>
              {joinInput('join-desktop')}
            </div>
          </div>
          {rooms !== null && visible.length === 0 && (
            <p className="text-sm text-slate-400">
              {filter === 'mine' ? 'Rooms you create or visit will appear here.' : 'No rooms yet. Create the first one.'}
            </p>
          )}
          <p className="text-xs text-slate-500">Hidden rooms only appear for their owner and for people who have visited them.</p>
        </main>

        <aside className="w-[380px] shrink-0 border-l border-white/10 bg-[#0D1424] px-6 py-7">
          <RoomCreateForm variant="panel" onCreated={enterRoom} />
        </aside>
      </div>

      {/* Info: (20261106 - Luphia) 手機版 (V3) */}
      <div className="flex flex-col gap-6 px-5 py-6 lg:hidden">
        <Link href="/" className="text-xl font-bold text-blue-400">
          Drop Here
        </Link>
        <section className="flex flex-col gap-3.5 rounded-[20px] border border-white/10 bg-[#0B1222] p-5" aria-labelledby="join-title">
          <h1 id="join-title" className="text-xl font-bold">
            Join a room
          </h1>
          {joinInput('join-mobile', true)}
          <div className="flex items-center gap-2.5 text-xs text-slate-400">
            <span className="h-px flex-1 bg-white/10" />
            or
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="inline-flex h-[50px] items-center justify-center gap-2 rounded-2xl bg-blue-600 text-[15px] font-bold text-white"
          >
            <PlusIcon className="h-4 w-4" />
            Create a new room
          </button>
        </section>

        {mine.length > 0 && (
          <section className="flex flex-col gap-2.5" aria-labelledby="mine-title">
            <h2 id="mine-title" className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
              Your rooms
            </h2>
            <div className="-mx-5 flex gap-2.5 overflow-x-auto px-5 pb-1">
              {mine.map(room => (
                <Link
                  key={room.roomNumber}
                  href={`/room/${room.roomNumber}`}
                  className={`flex w-40 shrink-0 flex-col gap-1 rounded-2xl border bg-[#0B1222] p-3 ${room.isOwner ? 'border-blue-800' : 'border-white/10'}`}
                >
                  <span className="flex items-center gap-1 text-[13px] font-semibold">
                    {room.hasPassword && <LockIcon className="h-3 w-3 shrink-0 text-amber-300" />}
                    <span className="truncate">{room.name}</span>
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {room.isOwner ? 'Owner' : 'Visited'}
                    {room.fileCount !== null ? ` · ${room.fileCount} files` : ''}
                  </span>
                  <span className={`text-[11px] ${room.uploading ? 'text-blue-300' : room.online ? 'text-emerald-300' : 'text-slate-400'}`}>
                    {room.uploading ? 'Uploading now' : room.online ? `${room.online} here` : formatExpiry(room.expiresAt === null ? null : room.expiresAt - now)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="flex flex-col" aria-labelledby="open-title">
          <h2 id="open-title" className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
            Open rooms
          </h2>
          {rooms === null && <p className="py-4 text-sm text-slate-400">Loading…</p>}
          {rooms !== null && listedRooms.length === 0 && <p className="py-4 text-sm text-slate-400">No public rooms right now.</p>}
          {listedRooms.map(room => (
            <Link
              key={room.roomNumber}
              href={`/room/${room.roomNumber}`}
              className="flex min-h-14 items-center gap-3 border-b border-white/10 px-1 py-2 last:border-0"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <span className="truncate">{room.name}</span>
                  {room.hasPassword && <LockIcon className="h-3.5 w-3.5 shrink-0 text-amber-300" />}
                </span>
                <span className="block text-xs text-slate-400">
                  #{room.roomNumber} · {room.fileCount !== null ? `${room.fileCount} files` : 'password'} ·{' '}
                  {formatExpiry(room.expiresAt === null ? null : room.expiresAt - now).replace('Expires in ', '')}
                </span>
              </span>
              <span className="text-slate-500" aria-hidden="true">
                ›
              </span>
            </Link>
          ))}
        </section>
      </div>

      {sheetOpen && (
        <div className="fixed inset-x-0 top-viewport z-50 h-viewport lg:hidden">
          <button type="button" aria-label="Close" onClick={() => setSheetOpen(false)} className="absolute inset-0 bg-slate-950/70" />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Create a room"
            className="absolute inset-x-0 bottom-0 flex h-[min(640px,92%)] flex-col rounded-t-3xl border-t border-white/10 bg-slate-900 px-5 pb-6 pt-3"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="mx-auto h-1 w-10 rounded-full bg-slate-700" aria-hidden="true" />
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setSheetOpen(false)}
              className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-lg"
            >
              <XIcon className="text-slate-400" />
            </button>
            <RoomCreateForm variant="steps" onCreated={enterRoom} onCancel={() => setSheetOpen(false)} />
          </section>
        </div>
      )}
    </div>
  );
}
