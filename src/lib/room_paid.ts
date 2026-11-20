import { promises as fs } from 'fs';
import path from 'path';
import { ROOM_BASE_DIR, isRoomOwner, readRoomConfig, writeRoomConfig, type IRoomConfig } from '@/lib/room_access';
import { setRoomGate } from '@/lib/chat_hub';
import { DAY_MS, GB, PAID_MIN_DAYS, type IRoomPayInfo } from '@/lib/pay_plans';

/**
 * Info: (20261120 - Luphia)
 * 房間的付費狀態 (伺服器端)：
 * - 方案：付費延長後的容量與期限；免費房間容量由 FREE_ROOM_GB 決定 (預設 10 GB)
 * - 付費進房：買家名單 (成員身分與付款錢包)、銷售紀錄，存放在房間目錄的 .pay/
 * - 內容閘門：沒有權限的人只看得到檔名與大小 (房主允許時) 與免費預覽檔；分片 (CID) 不外流
 */

export const FREE_ROOM_GB = Math.max(1, Number(process.env.FREE_ROOM_GB) || 10);

interface IAccessFile {
  // Info: (20261120 - Luphia) memberHash → 購買紀錄
  members: Record<string, { at: number; payer: string | null; signature: string | null }>;
  // Info: (20261120 - Luphia) 付款錢包 (換裝置時以錢包簽章恢復)
  wallets: Record<string, { at: number; signature: string }>;
}

export interface ISale {
  at: number;
  buyerName: string | null;
  payer: string;
  token: string;
  amount: number;
  owner: number;
  fee: number;
  signature: string;
}

const roomPathOf = (roomId: string) => path.join(ROOM_BASE_DIR, roomId);
const payDir = (roomPath: string) => path.join(roomPath, '.pay');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// Info: (20261120 - Luphia) 同一房間的設定與名單依序寫入 (付款與房主操作可能同時發生)
const locks = new Map<string, Promise<unknown>>();
export function withRoomLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(roomId) ?? Promise.resolve();
  const next = previous.then(task, task);
  locks.set(
    roomId,
    next.catch(() => undefined)
  );
  return next;
}

export const readAccess = (roomPath: string) => readJson<IAccessFile>(path.join(payDir(roomPath), 'access.json'), { members: {}, wallets: {} });
export const readSales = (roomPath: string) => readJson<ISale[]>(path.join(payDir(roomPath), 'sales.json'), []);

export const isPaidRoom = (config: IRoomConfig) => !!config.paid?.enabled;

export async function hasContentAccess(roomPath: string, config: IRoomConfig, memberHash: string | null): Promise<boolean> {
  if (!isPaidRoom(config) || isRoomOwner(config, memberHash)) return true;
  if (!memberHash) return false;
  const access = await readAccess(roomPath);
  return !!access.members[memberHash];
}

type TFileLike = Record<string, unknown> & { filename: string };

// Info: (20261120 - Luphia) 沒有權限時的檔案清單：免費預覽檔完整提供；其他只給檔名與大小 (或完全不給)
export function redactFiles<T extends TFileLike>(files: T[], config: IRoomConfig): T[] {
  const paid = config.paid;
  if (!paid?.enabled) return files;
  const preview = new Set(paid.previewFiles);
  return files
    .filter(f => paid.previewNames || preview.has(f.filename))
    .map(f => (preview.has(f.filename) ? f : ({ ...f, shards: [], locked: true } as T)));
}

// Info: (20261120 - Luphia) 更新聊天推送的閘門 (付費設定或名單改變、有人加入聊天時)
export async function refreshGate(roomId: string, config?: IRoomConfig) {
  const roomPath = roomPathOf(roomId);
  const current = config ?? (await readRoomConfig(roomPath));
  if (!current.paid?.enabled) {
    setRoomGate(roomId, null);
    return;
  }
  const access = await readAccess(roomPath);
  setRoomGate(roomId, {
    owner: current.ownerHash ?? null,
    members: new Set(Object.keys(access.members)),
    previewNames: current.paid.previewNames,
    previewFiles: new Set(current.paid.previewFiles),
  });
}

export function capacityBytes(config: IRoomConfig, now = Date.now()): number {
  const active = config.plan && config.plan.until > now ? config.plan.capacityGb : 0;
  return Math.max(active, FREE_ROOM_GB) * GB;
}

export const usedBytesOf = (files: Record<string, unknown>[]) =>
  files.reduce((sum, f) => sum + (typeof f.originalFileSize === 'number' ? f.originalFileSize : 0), 0);

// Info: (20261120 - Luphia) 付費房能不能賣：到期時間至少還有 30 天
export const onSale = (config: IRoomConfig, now = Date.now()) =>
  !!config.paid?.enabled && !!config.paid.payout && (config.expiration?.expiresAt ?? Infinity) >= now + PAID_MIN_DAYS * DAY_MS;

export async function payInfoFor(roomPath: string, config: IRoomConfig, memberHash: string | null, files: TFileLike[], payEnabled: boolean): Promise<IRoomPayInfo> {
  const now = Date.now();
  const paid = config.paid;
  const full = await hasContentAccess(roomPath, config, memberHash);
  return {
    enabled: payEnabled,
    plan: { capacityBytes: capacityBytes(config, now), until: config.plan && config.plan.until > now ? config.plan.until : null, paid: !!config.plan && config.plan.until > now },
    usedBytes: usedBytesOf(files),
    paid: paid?.enabled
      ? {
          enabled: true,
          price: paid.price,
          ownerName: paid.ownerName,
          ownerVerified: !!paid.payoutVerifiedAt,
          previewNames: paid.previewNames,
          previewFiles: paid.previewFiles,
          onSale: onSale(config, now),
        }
      : null,
    access: full ? 'full' : 'locked',
  };
}

// Info: (20261120 - Luphia) 付款完成：延長房間 (從目前到期時間或現在起算)，容量取較大者
export async function applyExtension(roomId: string, days: number, gb: number): Promise<{ expiresAt: number; capacityGb: number }> {
  return withRoomLock(roomId, async () => {
    const roomPath = roomPathOf(roomId);
    const config = await readRoomConfig(roomPath);
    const now = Date.now();
    const from = Math.max(now, config.expiration?.expiresAt ?? now);
    const expiresAt = from + days * DAY_MS;
    const activeGb = config.plan && config.plan.until > now ? config.plan.capacityGb : 0;
    const capacityGb = Math.max(activeGb, gb);
    const next: IRoomConfig = {
      ...config,
      expiration: { expiresAt, setAt: now, minutes: Math.round((expiresAt - now) / 60000) },
      plan: { capacityGb, until: expiresAt },
    };
    await writeRoomConfig(roomPath, next);
    return { expiresAt, capacityGb };
  });
}

// Info: (20261120 - Luphia) 付款完成：買家取得權限 (成員身分與付款錢包)，記錄銷售
export async function applyPurchase(roomId: string, buyer: { memberHash: string | null; name: string | null }, sale: Omit<ISale, 'at' | 'buyerName'>) {
  await withRoomLock(roomId, async () => {
    const roomPath = roomPathOf(roomId);
    const now = Date.now();
    const access = await readAccess(roomPath);
    if (buyer.memberHash) access.members[buyer.memberHash] = { at: now, payer: sale.payer, signature: sale.signature };
    access.wallets[sale.payer] = { at: now, signature: sale.signature };
    await writeJson(path.join(payDir(roomPath), 'access.json'), access);
    const sales = await readSales(roomPath);
    sales.push({ ...sale, at: now, buyerName: buyer.name });
    await writeJson(path.join(payDir(roomPath), 'sales.json'), sales);
    const config = await readRoomConfig(roomPath);
    if (config.paid) await writeRoomConfig(roomPath, { ...config, paid: { ...config.paid, lastSaleAt: now } });
  });
  await refreshGate(roomId);
}

// Info: (20261120 - Luphia) 以付款錢包恢復權限 (換裝置或換瀏覽器)
export async function restoreByWallet(roomId: string, wallet: string, memberHash: string): Promise<boolean> {
  const granted = await withRoomLock(roomId, async () => {
    const roomPath = roomPathOf(roomId);
    const access = await readAccess(roomPath);
    const record = access.wallets[wallet];
    if (!record) return false;
    access.members[memberHash] = { at: Date.now(), payer: wallet, signature: record.signature };
    await writeJson(path.join(payDir(roomPath), 'access.json'), access);
    return true;
  });
  if (granted) await refreshGate(roomId);
  return granted;
}

export async function updatePaidConfig(roomId: string, patch: (config: IRoomConfig) => IRoomConfig | { error: string }): Promise<IRoomConfig | { error: string }> {
  const result = await withRoomLock(roomId, async () => {
    const roomPath = roomPathOf(roomId);
    const config = await readRoomConfig(roomPath);
    const next = patch(config);
    if ('error' in next) return next;
    await writeRoomConfig(roomPath, next);
    return next;
  });
  if (!('error' in result)) await refreshGate(roomId, result);
  return result;
}
