import { promises as fs } from 'fs';
import path from 'path';
import { DROPHERE_DATA_DIR } from '@/lib/server_env';
import { ROOM_BASE_DIR, isValidRoomId, readRoomConfig, type IRoomConfig } from '@/lib/room_access';
import { onSale, readSales, type ISale } from '@/lib/room_paid';
import { DAY_MS, PAID_MIN_DAYS } from '@/lib/pay_plans';

/**
 * Info: (20261122 - Luphia)
 * 房主收入 (跨房間)：以 CAFECA 帳戶的成員身分找出自己的房間，彙整付費進房的銷售
 * - 收入頁：期間內收到的金額、銷售數、平台手續費、各房間與每一筆銷售
 * - 通知：新銷售 (即時推送)、昨日摘要、付費房即將停賣 (剩不到 30 天就不能賣)
 * 已讀時間存在 DROPHERE_DATA_DIR/owners/<成員身分>.json
 */

// Info: (20261122 - Luphia) 剩幾天會停賣時開始提醒
export const ENDING_NOTICE_DAYS = 7;
const NOTICE_SALE_DAYS = 30;
const MAX_NOTICES = 40;
const MAX_RANGE_SALES = 5000;

export type TRoomSaleStatus = 'selling' | 'stopped' | 'paused' | 'setup';

export interface IOwnerRoom {
  roomId: string;
  name: string;
  price: number;
  status: TRoomSaleStatus;
  // Info: (20261122 - Luphia) 販售中的房間還有幾天會因剩不到 30 天而停賣
  stopsInDays: number | null;
  expiresAt: number | null;
  payout: string | null;
  count: number;
  received: number;
  lifetimeCount: number;
  lifetimeReceived: number;
}

export interface IOwnerSale {
  roomId: string;
  roomName: string;
  at: number;
  buyerName: string | null;
  token: string;
  amount: number;
  owner: number;
  fee: number;
  signature: string;
}

export interface IEarnings {
  range: TEarningsRange;
  since: number | null;
  totals: { received: number; fee: number; count: number; previousReceived: number | null; sellingRooms: number };
  payouts: { address: string; rooms: number }[];
  rooms: IOwnerRoom[];
  sales: IOwnerSale[];
  truncated: boolean;
}

export type TEarningsRange = '30d' | '90d' | 'all';
export const EARNINGS_RANGES: TEarningsRange[] = ['30d', '90d', 'all'];

export type TOwnerNotice =
  | { id: string; kind: 'sale'; at: number; roomId: string; roomName: string; amount: number; token: string; buyerName: string | null; signature: string }
  | { id: string; kind: 'summary'; at: number; day: string; count: number; amount: number }
  | { id: string; kind: 'ending'; at: number; roomId: string; roomName: string; days: number }
  | { id: string; kind: 'stopped'; at: number; roomId: string; roomName: string };

// Info: (20261122 - Luphia) 推送給房主的即時事件 (新銷售)
export type TOwnerEvent = { type: 'sale'; notice: Extract<TOwnerNotice, { kind: 'sale' }> };

const roomNameOf = (roomId: string, config: IRoomConfig) => config.name?.trim() || `Room ${roomId}`;

interface IOwnedRoom {
  roomId: string;
  roomPath: string;
  config: IRoomConfig;
}

// Info: (20261122 - Luphia) 房主有沒有用過付費功能 (設定過、正在設定或賣過)
const touchedPaid = (config: IRoomConfig) => !!config.paid;

export async function ownedRooms(memberHash: string): Promise<IOwnedRoom[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(ROOM_BASE_DIR);
  } catch {
    return [];
  }
  const now = Date.now();
  const rooms: IOwnedRoom[] = [];
  for (const roomId of entries) {
    if (!isValidRoomId(roomId)) continue;
    const roomPath = path.join(ROOM_BASE_DIR, roomId);
    const config = await readRoomConfig(roomPath);
    if (config.ownerHash !== memberHash) continue;
    if (typeof config.expiration?.expiresAt === 'number' && config.expiration.expiresAt < now) continue;
    rooms.push({ roomId, roomPath, config });
  }
  return rooms;
}

function statusOf(config: IRoomConfig, now: number): { status: TRoomSaleStatus; stopsInDays: number | null } {
  const paid = config.paid;
  if (paid?.enabled) {
    if (!onSale(config, now)) return { status: 'stopped', stopsInDays: null };
    const expiresAt = config.expiration?.expiresAt;
    const stopsInDays = typeof expiresAt === 'number' ? Math.max(0, Math.floor((expiresAt - PAID_MIN_DAYS * DAY_MS - now) / DAY_MS)) : null;
    return { status: 'selling', stopsInDays };
  }
  return { status: paid?.setupPending ? 'setup' : 'paused', stopsInDays: null };
}

async function paidRooms(memberHash: string) {
  const rooms = (await ownedRooms(memberHash)).filter(r => touchedPaid(r.config));
  return Promise.all(rooms.map(async r => ({ ...r, sales: await readSales(r.roomPath) })));
}

export async function earningsFor(memberHash: string, range: TEarningsRange): Promise<IEarnings> {
  const now = Date.now();
  const days = range === '30d' ? 30 : range === '90d' ? 90 : null;
  const since = days ? now - days * DAY_MS : null;
  const previousSince = days ? now - 2 * days * DAY_MS : null;
  const rooms = await paidRooms(memberHash);
  const rows: IOwnerRoom[] = [];
  const sales: IOwnerSale[] = [];
  const payouts = new Map<string, number>();
  let previousReceived = 0;
  let sellingRooms = 0;

  for (const { roomId, config, sales: roomSales } of rooms) {
    const name = roomNameOf(roomId, config);
    const inRange = roomSales.filter(s => since === null || s.at >= since);
    if (previousSince !== null && since !== null) {
      previousReceived += roomSales.filter(s => s.at >= previousSince && s.at < since).reduce((sum, s) => sum + s.owner, 0);
    }
    const { status, stopsInDays } = statusOf(config, now);
    if (status === 'selling') sellingRooms += 1;
    const payout = config.paid?.payout ?? null;
    if (payout && config.paid?.payoutVerifiedAt) payouts.set(payout, (payouts.get(payout) ?? 0) + 1);
    rows.push({
      roomId,
      name,
      price: config.paid?.price ?? 0,
      status,
      stopsInDays,
      expiresAt: config.expiration?.expiresAt ?? null,
      payout,
      count: inRange.length,
      received: inRange.reduce((sum, s) => sum + s.owner, 0),
      lifetimeCount: roomSales.length,
      lifetimeReceived: roomSales.reduce((sum, s) => sum + s.owner, 0),
    });
    inRange.forEach((s: ISale) => sales.push({ roomId, roomName: name, at: s.at, buyerName: s.buyerName, token: s.token, amount: s.amount, owner: s.owner, fee: s.fee, signature: s.signature }));
  }

  sales.sort((a, b) => b.at - a.at);
  const statusRank: Record<TRoomSaleStatus, number> = { selling: 0, stopped: 1, setup: 2, paused: 3 };
  rows.sort((a, b) => b.received - a.received || statusRank[a.status] - statusRank[b.status] || b.lifetimeReceived - a.lifetimeReceived);

  return {
    range,
    since,
    totals: {
      received: sales.reduce((sum, s) => sum + s.owner, 0),
      fee: sales.reduce((sum, s) => sum + s.fee, 0),
      count: sales.length,
      previousReceived: since === null ? null : previousReceived,
      sellingRooms,
    },
    payouts: [...payouts.entries()].map(([address, count]) => ({ address, rooms: count })),
    rooms: rows,
    sales: sales.slice(0, MAX_RANGE_SALES),
    truncated: sales.length > MAX_RANGE_SALES,
  };
}

// --- Info: (20261122 - Luphia) 通知 ---

const ownerFile = (memberHash: string) => path.join(DROPHERE_DATA_DIR, 'owners', `${memberHash}.json`);

async function readSeenAt(memberHash: string): Promise<number> {
  try {
    const data = JSON.parse(await fs.readFile(ownerFile(memberHash), 'utf-8')) as { seenAt?: unknown };
    return typeof data.seenAt === 'number' ? data.seenAt : 0;
  } catch {
    return 0;
  }
}

export async function markNoticesSeen(memberHash: string, at = Date.now()) {
  const file = ownerFile(memberHash);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ seenAt: at }));
  await fs.rename(tmp, file);
  return at;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Info: (20261122 - Luphia)
 * @param tzOffset - 瀏覽器的 getTimezoneOffset() (分鐘)，用來決定「昨天」
 */
export async function noticesFor(memberHash: string, tzOffset: number) {
  const now = Date.now();
  const rooms = await paidRooms(memberHash);
  const notices: TOwnerNotice[] = [];
  const offsetMs = tzOffset * 60_000;
  // Info: (20261122 - Luphia) 使用者當地的今天 0 點 (UTC 時間戳)
  const localNow = now - offsetMs;
  const todayStart = localNow - (localNow % DAY_MS) + offsetMs;
  const yesterdayStart = todayStart - DAY_MS;
  let yesterdayCount = 0;
  let yesterdayAmount = 0;
  let received30 = 0;

  for (const { roomId, config, sales } of rooms) {
    const roomName = roomNameOf(roomId, config);
    for (const s of sales) {
      if (s.at >= now - 30 * DAY_MS) received30 += s.owner;
      if (s.at >= now - NOTICE_SALE_DAYS * DAY_MS) {
        notices.push({ id: `sale:${s.signature}`, kind: 'sale', at: s.at, roomId, roomName, amount: s.owner, token: s.token, buyerName: s.buyerName, signature: s.signature });
      }
      if (s.at >= yesterdayStart && s.at < todayStart) {
        yesterdayCount += 1;
        yesterdayAmount += s.owner;
      }
    }
    const expiresAt = config.expiration?.expiresAt;
    if (config.paid?.enabled && typeof expiresAt === 'number') {
      const stopAt = expiresAt - PAID_MIN_DAYS * DAY_MS;
      if (stopAt <= now) {
        notices.push({ id: `stopped:${roomId}:${stopAt}`, kind: 'stopped', at: stopAt, roomId, roomName });
      } else if (stopAt - now <= ENDING_NOTICE_DAYS * DAY_MS) {
        notices.push({ id: `ending:${roomId}:${stopAt}`, kind: 'ending', at: stopAt - ENDING_NOTICE_DAYS * DAY_MS, roomId, roomName, days: Math.floor((stopAt - now) / DAY_MS) });
      }
    }
  }
  if (yesterdayCount > 0) {
    const local = new Date(yesterdayStart - offsetMs);
    const day = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    notices.push({ id: `summary:${day}`, kind: 'summary', at: todayStart, day, count: yesterdayCount, amount: yesterdayAmount });
  }
  notices.sort((a, b) => b.at - a.at);
  const seenAt = await readSeenAt(memberHash);
  const list = notices.slice(0, MAX_NOTICES);
  return {
    // Info: (20261122 - Luphia) 用過付費功能才顯示鈴鐺與收入
    active: rooms.length > 0,
    seenAt,
    unread: list.filter(n => n.at > seenAt).length,
    received30,
    notices: list,
  };
}

// --- Info: (20261122 - Luphia) 即時推送 (單一 Node 程序；掛在 globalThis 避免熱更新產生多份) ---

type TListener = (event: TOwnerEvent) => void;
const globalForOwner = globalThis as unknown as { drophereOwnerBus?: Map<string, Set<TListener>> };
const bus = (globalForOwner.drophereOwnerBus ??= new Map<string, Set<TListener>>());

export function subscribeOwner(memberHash: string, listener: TListener) {
  const set = bus.get(memberHash) ?? new Set<TListener>();
  set.add(listener);
  bus.set(memberHash, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) bus.delete(memberHash);
  };
}

export function emitOwner(memberHash: string, event: TOwnerEvent) {
  bus.get(memberHash)?.forEach(listener => {
    try {
      listener(event);
    } catch {
      // Info: (20261122 - Luphia) 單一連線出錯不影響其他連線
    }
  });
}

export const MAX_OWNER_STREAMS = 8;
export const ownerStreamCount = (memberHash: string) => bus.get(memberHash)?.size ?? 0;
