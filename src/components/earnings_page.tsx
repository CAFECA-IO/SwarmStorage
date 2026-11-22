import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AccountButton from '@/components/account_button';
import { DownloadIcon, ExternalIcon, WalletIcon } from '@/components/icons';
import { timeAgo } from '@/components/notification_bell';
import { ApiCode } from '@/lib/status';
import { formatAmount, shortAddress } from '@/lib/pay_plans';
import { SALE_EVENT } from '@/lib/use_owner_notices';
import type { IEarnings, IOwnerRoom, TEarningsRange } from '@/lib/owner_earnings';

/**
 * Info: (20261122 - Luphia)
 * 收入頁 (帳號選單 → Earnings)：自己所有付費房的收入
 * - 期間：30 天、90 天、全部；收到的金額、銷售數、平台手續費、收款錢包
 * - 每日 (全部期間為每月) 收入圖、各房間收入、最近的銷售 (Solscan 連結)、CSV 匯出
 * - 有新銷售時自動更新
 */

const RANGES: [TEarningsRange, string][] = [
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];
const SALES_PAGE = 10;
const txUrl = (signature: string) => `https://solscan.io/tx/${signature}`;

type TLoad = { state: 'loading' } | { state: 'signed-out' } | { state: 'error'; message: string } | { state: 'ready'; data: IEarnings };

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

interface IBucket {
  key: string;
  label: string;
  amount: number;
  count: number;
}

// Info: (20261122 - Luphia) 依使用者當地日期分組 (全部期間依月份，最多 24 個月)
function buildBuckets(data: IEarnings): IBucket[] {
  const now = new Date();
  const buckets: IBucket[] = [];
  if (data.range === 'all') {
    const oldest = data.sales.length ? new Date(data.sales[data.sales.length - 1].at) : now;
    const months = Math.min(24, Math.max(6, (now.getFullYear() - oldest.getFullYear()) * 12 + now.getMonth() - oldest.getMonth() + 1));
    for (let i = months - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: monthKey(d), label: d.toLocaleDateString([], { year: 'numeric', month: 'short' }), amount: 0, count: 0 });
    }
  } else {
    const days = data.range === '30d' ? 30 : 90;
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      buckets.push({ key: dayKey(d), label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), amount: 0, count: 0 });
    }
  }
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  for (const s of data.sales) {
    const d = new Date(s.at);
    const i = index.get(data.range === 'all' ? monthKey(d) : dayKey(d));
    if (i === undefined) continue;
    buckets[i].amount += s.owner;
    buckets[i].count += 1;
  }
  return buckets;
}

function ReceivedChart({ data }: { data: IEarnings }) {
  const buckets = useMemo(() => buildBuckets(data), [data]);
  const max = Math.max(...buckets.map(b => b.amount), 1);
  const best = buckets.reduce((top, b) => (b.amount > top.amount ? b : top), buckets[0]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{data.range === 'all' ? 'Received per month' : 'Received per day'}</h2>
        <p className="text-xs text-slate-400">
          {buckets[0]?.label} – {buckets[buckets.length - 1]?.label}
        </p>
      </div>
      <div
        className="flex h-[120px] items-end gap-[2px] border-b border-white/10"
        role="img"
        aria-label={best && best.amount > 0 ? `Amount received per ${data.range === 'all' ? 'month' : 'day'}; highest ${formatAmount(best.amount)} on ${best.label}` : 'No sales in this period'}
      >
        {buckets.map(b => (
          // Info: (20261122 - Luphia) 滑過時以瀏覽器提示顯示日期、金額與筆數
          <div key={b.key} className="group flex h-full min-w-0 flex-1 items-end" title={`${b.label} · ${formatAmount(b.amount)} · ${b.count === 1 ? '1 sale' : `${b.count} sales`}`}>
            <div
              className={`w-full rounded-t-[4px] bg-emerald-500 transition-colors group-hover:bg-emerald-300 ${b.amount === 0 ? 'opacity-0' : ''}`}
              style={{ height: `${b.amount === 0 ? 0 : Math.max(4, (b.amount / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const statusChip = (room: IOwnerRoom) => {
  if (room.status === 'selling') {
    if (room.stopsInDays !== null && room.stopsInDays <= 7) return <span className="text-amber-300">Stops selling in {room.stopsInDays < 1 ? 'under a day' : `${room.stopsInDays} d`}</span>;
    return <span className="text-violet-300">● Selling</span>;
  }
  if (room.status === 'stopped') return <span className="text-red-300">Not on sale · under 30 days left</span>;
  if (room.status === 'setup') return <span className="text-slate-400">Setting up</span>;
  return <span className="text-amber-300">Paused</span>;
};

const needsExtend = (room: IOwnerRoom) => room.status === 'stopped' || (room.status === 'selling' && room.stopsInDays !== null && room.stopsInDays <= 7);

function RoomsTable({ rooms }: { rooms: IOwnerRoom[] }) {
  if (rooms.length === 0) return <p className="py-6 text-center text-[13px] text-slate-500">You don’t sell access to any room yet.</p>;
  return (
    <>
      {/* Info: (20261122 - Luphia) 桌面版：表格 */}
      <table className="hidden w-full text-[13px] sm:table">
        <thead>
          <tr className="border-b border-white/10 text-left text-xs text-slate-500">
            <th className="py-2 pr-2 font-normal">Room</th>
            <th className="py-2 pr-2 font-normal">Price</th>
            <th className="py-2 pr-2 text-right font-normal">Sales</th>
            <th className="py-2 pr-2 text-right font-normal">You received</th>
            <th className="py-2 pl-3 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map(r => (
            <tr key={r.roomId} className="border-b border-white/5 last:border-0">
              <td className="py-2.5 pr-2">
                <Link href={`/room/${r.roomId}`} className="text-slate-100 hover:underline">
                  {r.name}
                </Link>{' '}
                <span className="text-slate-500">· {r.roomId}</span>
              </td>
              <td className="py-2.5 pr-2 text-slate-300">{formatAmount(r.price)} USD</td>
              <td className="py-2.5 pr-2 text-right tabular-nums text-slate-200">{r.count}</td>
              <td className="py-2.5 pr-2 text-right font-semibold tabular-nums text-slate-100">{formatAmount(r.received)}</td>
              <td className="py-2.5 pl-3 text-xs">
                {statusChip(r)}
                {needsExtend(r) && (
                  <>
                    {' · '}
                    <Link href={`/room/${r.roomId}?panel=plan`} className="font-semibold text-blue-300 hover:underline">
                      Extend
                    </Link>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Info: (20261122 - Luphia) 手機版：清單 */}
      <ul className="flex flex-col sm:hidden">
        {rooms.map(r => (
          <li key={r.roomId} className="flex items-center gap-3 border-b border-white/5 py-3 text-[13px] last:border-0">
            <div className="min-w-0 flex-1">
              <Link href={`/room/${r.roomId}`} className="block truncate text-slate-100">
                {r.name}
              </Link>
              <p className="mt-0.5 text-xs">
                {statusChip(r)}
                <span className="text-slate-500">
                  {' '}
                  · {formatAmount(r.price)} USD · {r.count === 1 ? '1 sale' : `${r.count} sales`}
                </span>
                {needsExtend(r) && (
                  <>
                    {' · '}
                    <Link href={`/room/${r.roomId}?panel=plan`} className="font-semibold text-blue-300">
                      Extend
                    </Link>
                  </>
                )}
              </p>
            </div>
            <span className="font-semibold tabular-nums text-slate-100">{formatAmount(r.received)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function SalesList({ data }: { data: IEarnings }) {
  const [limit, setLimit] = useState(SALES_PAGE);
  if (data.sales.length === 0) return <p className="py-6 text-center text-[13px] text-slate-500">No sales in this period.</p>;
  return (
    <>
      <ul className="flex flex-col">
        {data.sales.slice(0, limit).map(s => (
          <li key={s.signature} className="flex items-center gap-3 border-b border-white/5 py-2.5 text-[13px] last:border-0">
            <div className="min-w-0 flex-1">
              <p className="truncate text-slate-100">
                {s.buyerName ?? 'A guest'} <span className="text-slate-400">bought</span> {s.roomName}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {timeAgo(s.at)} · {s.token} · paid {formatAmount(s.amount)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-semibold tabular-nums text-emerald-300">+{formatAmount(s.owner)}</p>
              <a href={txUrl(s.signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-300 hover:underline">
                Solscan
                <ExternalIcon className="h-3 w-3" />
              </a>
            </div>
          </li>
        ))}
      </ul>
      {data.sales.length > limit && (
        <button type="button" onClick={() => setLimit(n => n + 50)} className="mt-2 w-full rounded-lg py-2 text-center text-[13px] font-semibold text-blue-300 hover:bg-white/5">
          Show more ({data.sales.length - limit} left)
        </button>
      )}
    </>
  );
}

function SummaryCards({ data }: { data: IEarnings }) {
  const { totals } = data;
  const diff = totals.previousReceived === null ? null : totals.received - totals.previousReceived;
  const card = 'rounded-2xl border border-white/10 bg-[#0F172A] p-4';
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      <div className="col-span-2 rounded-2xl border border-emerald-500/30 bg-emerald-950/40 p-4 lg:col-span-1">
        <p className="text-xs text-emerald-300">You received</p>
        <p className="mt-1.5 text-[28px] font-bold leading-8 tabular-nums text-white">
          {formatAmount(totals.received)} <span className="text-sm font-semibold text-emerald-300">USDC/T</span>
        </p>
        <p className="mt-1 text-xs text-slate-400">{diff === null ? 'Since your first sale' : `${diff >= 0 ? '+' : '−'}${formatAmount(Math.abs(diff))} vs the ${data.range === '30d' ? '30' : '90'} days before`}</p>
      </div>
      <div className={card}>
        <p className="text-xs text-slate-400">Sales</p>
        <p className="mt-1.5 text-[28px] font-bold leading-8 tabular-nums text-white">{totals.count}</p>
        <p className="mt-1 text-xs text-slate-400">{totals.sellingRooms === 1 ? '1 room selling' : `${totals.sellingRooms} rooms selling`}</p>
      </div>
      <div className={card}>
        <p className="text-xs text-slate-400">DropHere fee (10%)</p>
        <p className="mt-1.5 text-[28px] font-bold leading-8 tabular-nums text-white">{formatAmount(totals.fee)}</p>
        <p className="mt-1 text-xs text-slate-400">Network fees paid by DropHere</p>
      </div>
      <div className={`${card} col-span-2 lg:col-span-1`}>
        <p className="flex items-center gap-1.5 text-xs text-slate-400">
          <WalletIcon className="h-3.5 w-3.5" />
          Payout {data.payouts.length > 1 ? 'wallets' : 'wallet'}
        </p>
        {data.payouts.length === 0 ? (
          <p className="mt-2.5 text-[13px] text-slate-400">Not set yet</p>
        ) : (
          data.payouts.slice(0, 3).map(p => (
            <p key={p.address} className="mt-2 text-[13px]">
              <span className="font-mono font-semibold text-white" title={p.address}>
                {shortAddress(p.address)}
              </span>
              <span className="ml-2 text-xs text-emerald-300">✓ Verified · {p.rooms === 1 ? '1 room' : `${p.rooms} rooms`}</span>
            </p>
          ))
        )}
      </div>
    </div>
  );
}

export default function EarningsPage() {
  const [range, setRange] = useState<TEarningsRange>('30d');
  const [load, setLoad] = useState<TLoad>({ state: 'loading' });

  const fetchEarnings = useCallback(async (which: TEarningsRange) => {
    try {
      const res = await fetch(`/api/v1/me/earnings?range=${which}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.code === ApiCode.UNAUTHORIZED) return setLoad({ state: 'signed-out' });
      if (data.code !== ApiCode.OK) return setLoad({ state: 'error', message: data.message || 'Could not load your earnings' });
      setLoad({ state: 'ready', data: data.payload as IEarnings });
    } catch {
      setLoad({ state: 'error', message: 'Could not reach the server' });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEarnings(range);
    // Info: (20261122 - Luphia) 有新銷售 (鈴鐺收到推送) 時重新讀取
    const onSale = () => fetchEarnings(range);
    window.addEventListener(SALE_EVENT, onSale);
    return () => window.removeEventListener(SALE_EVENT, onSale);
  }, [fetchEarnings, range]);

  const panel = 'rounded-2xl border border-white/10 bg-[#0F172A] p-4 lg:p-5';

  return (
    <div className="min-h-dvh bg-slate-950 font-sans text-slate-100">
      <header className="flex h-14 items-center gap-3 border-b border-white/10 bg-[#0B1222] px-4 lg:h-[60px] lg:px-8">
        <Link href="/" className="text-lg font-bold text-blue-400">
          Drop Here
        </Link>
        <span className="text-sm text-slate-500">/ Earnings</span>
        <div className="flex-1" />
        <AccountButton />
      </header>
      <main className="mx-auto flex max-w-[1376px] flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold text-white lg:text-[26px]">Earnings</h1>
            <p className="mt-1 text-[13px] text-slate-400">Money goes straight to your wallet when someone buys access. DropHere keeps 10%.</p>
          </div>
          <div className="flex w-full gap-1 rounded-xl border border-white/10 bg-[#0F172A] p-[3px] sm:w-auto" role="group" aria-label="Period">
            {RANGES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
                className={`flex-1 rounded-lg px-3 py-1.5 text-[13px] sm:flex-none ${range === value ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {load.state === 'ready' && load.data.totals.count > 0 && (
            <a
              href={`/api/v1/me/earnings?range=${range}&format=csv`}
              download
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/15 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-white/5"
            >
              <DownloadIcon className="h-4 w-4" />
              Export CSV
            </a>
          )}
        </div>

        {load.state === 'loading' && <p className="py-16 text-center text-sm text-slate-500">Loading…</p>}
        {load.state === 'signed-out' && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-slate-300">Sign in with CAFECA to see what your rooms have earned.</p>
            <AccountButton />
          </div>
        )}
        {load.state === 'error' && (
          <p role="alert" className="py-16 text-center text-sm text-red-300">
            {load.message}{' '}
            <button type="button" onClick={() => fetchEarnings(range)} className="font-semibold underline">
              Try again
            </button>
          </p>
        )}
        {load.state === 'ready' &&
          (load.data.rooms.length === 0 ? (
            <div className={`${panel} py-12 text-center`}>
              <p className="text-sm text-slate-300">You don’t sell access to any room yet.</p>
              <p className="mt-1 text-[13px] text-slate-500">Open one of your rooms, go to Plan, and set up “Sell access”.</p>
              <Link href="/" className="mt-4 inline-block rounded-xl bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-blue-500">
                Go to your rooms
              </Link>
            </div>
          ) : (
            <>
              <SummaryCards data={load.data} />
              <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
                <section className={`${panel} flex flex-col gap-5`}>
                  <ReceivedChart data={load.data} />
                  <div>
                    <h2 className="mb-1 text-sm font-semibold text-white">By room</h2>
                    <RoomsTable rooms={load.data.rooms} />
                  </div>
                </section>
                <section className={panel}>
                  <h2 className="mb-1 flex items-baseline justify-between text-sm font-semibold text-white">
                    Recent sales <span className="text-xs font-normal text-slate-500">all rooms</span>
                  </h2>
                  <SalesList key={range} data={load.data} />
                </section>
              </div>
            </>
          ))}
      </main>
    </div>
  );
}
