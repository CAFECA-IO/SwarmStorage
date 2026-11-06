import { promises as fs } from 'fs';
import path from 'path';
import {
  ROOM_BASE_DIR,
  canUpload,
  hashPassword,
  isRoomOwner,
  isValidRoomId,
  readRoomConfig,
  uploaderIdFor,
  writeRoomConfig,
  type IRoomConfig,
  type TUploadPolicy,
} from '@/lib/room_access';
import { endCall } from '@/lib/call_service';
import { announceFile, announceFileRemoved, closeRoom, onlineCount, uploadingCount } from '@/lib/chat_hub';

/**
 * Info: (20261106 - Luphia)
 * 房間資料存取 (伺服器端)：建立房間、房間清單、檔案 metadata、刪除 (可復原) 與清理
 */

const IPFS_API_URL = 'http://127.0.0.1:5001';
const TRASH_DIR = '.trash';
// Info: (20261106 - Luphia) 刪除後可復原的時間
export const DELETE_UNDO_MS = 10 * 1000;
// Info: (20261106 - Luphia) 沒有檔案、沒有人在線的房間保留 24 小時
const EMPTY_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_ROOM_NAME = 60;
export const RETENTION_MINUTES = [10, 60, 1440, 10080];

const RESERVED_NAMES = ['_config', 'metadata', 'password.hash', 'expiration'];

export type TFileMetadata = Record<string, unknown> & { filename: string; shards?: unknown; uploaderId?: string | null };

export interface IRoomSummary {
  roomNumber: string;
  name: string;
  listed: boolean;
  hasPassword: boolean;
  uploadPolicy: TUploadPolicy;
  // Info: (20261106 - Luphia) 受密碼保護且非建立者時不提供檔案數量與大小
  fileCount: number | null;
  totalSize: number | null;
  online: number;
  uploading: number;
  expiresAt: number | null;
  createdAt: number | null;
  isOwner: boolean;
}

export interface IRoomSettings {
  roomNumber: string;
  name: string;
  listed: boolean;
  uploadPolicy: TUploadPolicy;
  allowDownload: boolean;
  hasPassword: boolean;
  expiresAt: number | null;
  minutes: number | null;
  isOwner: boolean;
  canUpload: boolean;
  myUploaderId: string | null;
  serverTime: number;
}

export const isValidFilename = (filename: unknown): filename is string =>
  typeof filename === 'string' &&
  filename.length > 0 &&
  filename.length <= 255 &&
  !/[\\/\0]/.test(filename) &&
  !filename.startsWith('.') &&
  !RESERVED_NAMES.includes(filename);

export const roomDisplayName = (roomId: string, config: IRoomConfig) => config.name?.trim() || `Room ${roomId}`;

export const sanitizeRoomName = (name: unknown): string =>
  typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM_NAME) : '';

const roomPathOf = (roomId: string) => path.join(ROOM_BASE_DIR, roomId);
const metadataPathOf = (roomPath: string, filename: string) => path.join(roomPath, `${filename}.json`);
const trashPathOf = (roomPath: string, filename: string) => path.join(roomPath, TRASH_DIR, `${filename}.json`);

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function listRoomFiles(roomPath: string): Promise<TFileMetadata[]> {
  const entries = await fs.readdir(roomPath, { withFileTypes: true });
  const files: TFileMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (['_config.json', 'metadata.json', 'expiration.json'].includes(entry.name)) continue;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(roomPath, entry.name), 'utf-8'));
      if (metadata && typeof metadata.filename === 'string') files.push(metadata);
    } catch {
      // Info: (20261106 - Luphia) 略過格式錯誤的檔案
    }
  }
  return files;
}

const settingsFor = (roomId: string, config: IRoomConfig, memberHash: string | null): IRoomSettings => ({
  roomNumber: roomId,
  name: roomDisplayName(roomId, config),
  listed: !!config.listed,
  uploadPolicy: config.uploadPolicy ?? 'everyone',
  allowDownload: config.allowDownload !== false,
  hasPassword: !!config.passwordHash,
  expiresAt: config.expiration?.expiresAt ?? null,
  minutes: config.expiration?.minutes ?? null,
  isOwner: isRoomOwner(config, memberHash),
  canUpload: canUpload(config, memberHash),
  myUploaderId: uploaderIdFor(roomId, memberHash),
  serverTime: Date.now(),
});

export const getRoomSettings = settingsFor;

// Info: (20261106 - Luphia) 廣播給房間成員的設定 (不含個人欄位)
export const publicSettings = (roomId: string, config: IRoomConfig) => {
  const { isOwner, canUpload: _canUpload, myUploaderId, serverTime, ...rest } = settingsFor(roomId, config, null);
  void isOwner;
  void _canUpload;
  void myUploaderId;
  void serverTime;
  return rest;
};

/**
 * Info: (20261106 - Luphia)
 * 建立房間：由建立者一次指定名稱、公開、上傳權限、下載、密碼與保存時間
 */
export async function createRoom(options: {
  name: unknown;
  listed: unknown;
  uploadPolicy: unknown;
  allowDownload: unknown;
  password: unknown;
  minutes: unknown;
  ownerHash: string;
}): Promise<{ roomNumber: string } | { error: string }> {
  const minutes = Number(options.minutes);
  if (!RETENTION_MINUTES.includes(minutes)) return { error: 'Invalid retention' };
  if (options.uploadPolicy !== 'owner' && options.uploadPolicy !== 'everyone') return { error: 'Invalid upload policy' };
  if (options.password !== undefined && options.password !== null && (typeof options.password !== 'string' || options.password.length > 128)) {
    return { error: 'Invalid password' };
  }

  await fs.mkdir(ROOM_BASE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const roomNumber = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
    const roomPath = roomPathOf(roomNumber);
    try {
      await fs.mkdir(roomPath);
    } catch {
      continue;
    }
    const now = Date.now();
    const config: IRoomConfig = {
      name: sanitizeRoomName(options.name) || undefined,
      listed: options.listed !== false,
      uploadPolicy: options.uploadPolicy,
      allowDownload: options.allowDownload !== false,
      ownerHash: options.ownerHash,
      createdAt: now,
      expiration: { expiresAt: now + minutes * 60 * 1000, setAt: now, minutes },
    };
    if (typeof options.password === 'string' && options.password) config.passwordHash = hashPassword(options.password);
    await writeRoomConfig(roomPath, config);
    return { roomNumber };
  }
  return { error: 'Failed to generate a unique room number' };
}

/**
 * Info: (20261106 - Luphia)
 * 房間清單：公開的房間 + 自己建立的房間 + 指定房號 (最近造訪)
 */
export async function listRooms(memberHash: string | null, include: string[]): Promise<IRoomSummary[]> {
  await cleanupRooms();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(ROOM_BASE_DIR);
  } catch {
    return [];
  }
  const wanted = new Set(include.filter(isValidRoomId));
  const now = Date.now();
  const rooms: IRoomSummary[] = [];

  for (const roomId of entries) {
    if (!isValidRoomId(roomId)) continue;
    const roomPath = roomPathOf(roomId);
    const config = await readRoomConfig(roomPath);
    const expiresAt = config.expiration?.expiresAt ?? null;
    if (expiresAt !== null && now > expiresAt) continue;
    const isOwner = isRoomOwner(config, memberHash);
    if (!config.listed && !isOwner && !wanted.has(roomId)) continue;

    const hidden = !!config.passwordHash && !isOwner;
    let fileCount: number | null = null;
    let totalSize: number | null = null;
    if (!hidden) {
      const files = await listRoomFiles(roomPath);
      fileCount = files.length;
      totalSize = files.reduce((sum, f) => sum + (typeof f.originalFileSize === 'number' ? f.originalFileSize : 0), 0);
    }

    rooms.push({
      roomNumber: roomId,
      name: roomDisplayName(roomId, config),
      listed: !!config.listed,
      hasPassword: !!config.passwordHash,
      uploadPolicy: config.uploadPolicy ?? 'everyone',
      fileCount,
      totalSize,
      online: onlineCount(roomId),
      uploading: uploadingCount(roomId),
      expiresAt,
      createdAt: config.createdAt ?? null,
      isOwner,
    });
  }
  return rooms;
}

/**
 * Info: (20261106 - Luphia)
 * 更新房間設定 (僅限建立者)
 */
export async function updateRoomSettings(
  roomPath: string,
  config: IRoomConfig,
  patch: Record<string, unknown>
): Promise<IRoomConfig | { error: string }> {
  const next: IRoomConfig = { ...config };
  if ('name' in patch) next.name = sanitizeRoomName(patch.name) || undefined;
  if ('listed' in patch) {
    if (typeof patch.listed !== 'boolean') return { error: 'Invalid listed value' };
    next.listed = patch.listed;
  }
  if ('uploadPolicy' in patch) {
    if (patch.uploadPolicy !== 'owner' && patch.uploadPolicy !== 'everyone') return { error: 'Invalid upload policy' };
    next.uploadPolicy = patch.uploadPolicy;
  }
  if ('allowDownload' in patch) {
    if (typeof patch.allowDownload !== 'boolean') return { error: 'Invalid allowDownload value' };
    next.allowDownload = patch.allowDownload;
  }
  if ('password' in patch) {
    if (patch.password === null || patch.password === '') delete next.passwordHash;
    else if (typeof patch.password === 'string' && patch.password.length <= 128) next.passwordHash = hashPassword(patch.password);
    else return { error: 'Invalid password' };
  }
  if ('minutes' in patch) {
    const minutes = Number(patch.minutes);
    if (!RETENTION_MINUTES.includes(minutes)) return { error: 'Invalid retention' };
    const now = Date.now();
    next.expiration = { expiresAt: now + minutes * 60 * 1000, setAt: now, minutes };
  }
  await writeRoomConfig(roomPath, next);
  return next;
}

async function findFreeFilename(roomPath: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(await exists(metadataPathOf(roomPath, candidate))) && !(await exists(trashPathOf(roomPath, candidate)))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

const sameExceptShards = (a: TFileMetadata, b: TFileMetadata) => {
  const strip = ({ shards, repairedAt, ...rest }: TFileMetadata) => {
    void shards;
    void repairedAt;
    return JSON.stringify(rest);
  };
  return strip({ ...a, uploaderId: null }) === strip({ ...b, uploaderId: null });
};

export type TSaveFileResult = { ok: true; metadata: TFileMetadata } | { ok: false; status: 'forbidden' | 'invalid'; message: string };

/**
 * Info: (20261106 - Luphia)
 * 儲存檔案 metadata 並記錄上傳者：
 * - 新檔案：檢查上傳權限，記錄上傳者代號
 * - 同名檔案：上傳者或建立者可覆寫；其他人只能更新分片 (修復)；新上傳則自動改名
 */
export async function saveFileMetadata(
  roomId: string,
  roomPath: string,
  config: IRoomConfig,
  memberHash: string | null,
  incoming: TFileMetadata,
  uploadId: string | null
): Promise<TSaveFileResult> {
  if (!isValidFilename(incoming.filename)) return { ok: false, status: 'invalid', message: 'Invalid filename' };
  const myId = uploaderIdFor(roomId, memberHash);
  const owner = isRoomOwner(config, memberHash);
  const targetPath = metadataPathOf(roomPath, incoming.filename);

  let existing: TFileMetadata | null = null;
  try {
    existing = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
  } catch {
    existing = null;
  }

  let saved: TFileMetadata;
  if (!existing) {
    if (!canUpload(config, memberHash)) return { ok: false, status: 'forbidden', message: 'Only the room owner can upload' };
    saved = { ...incoming, uploaderId: myId };
  } else if ((myId && existing.uploaderId === myId) || owner) {
    saved = { ...incoming, uploaderId: existing.uploaderId ?? null };
  } else if (!uploadId && sameExceptShards(existing, incoming)) {
    // Info: (20261106 - Luphia) 修復：任何人都可以補回遺失的分片
    saved = { ...existing, shards: incoming.shards, repairedAt: incoming.repairedAt };
  } else if (uploadId) {
    if (!canUpload(config, memberHash)) return { ok: false, status: 'forbidden', message: 'Only the room owner can upload' };
    const filename = await findFreeFilename(roomPath, incoming.filename);
    saved = { ...incoming, filename, uploaderId: myId };
  } else {
    return { ok: false, status: 'forbidden', message: 'Only the uploader or the room owner can change this file' };
  }

  await fs.writeFile(metadataPathOf(roomPath, saved.filename), JSON.stringify(saved, null, 2));
  announceFile(roomId, saved, uploadId);
  return { ok: true, metadata: saved };
}

const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Info: (20261106 - Luphia)
 * 刪除檔案 (上傳者或建立者)：先移到待刪除區並通知所有人，10 秒內可復原，之後才真正刪除並釋放分片
 */
export async function deleteFile(
  roomId: string,
  roomPath: string,
  config: IRoomConfig,
  memberHash: string | null,
  filename: string
): Promise<{ ok: true; undoUntil: number } | { ok: false; status: 'forbidden' | 'not_found'; message: string }> {
  const source = metadataPathOf(roomPath, filename);
  let metadata: TFileMetadata;
  try {
    metadata = JSON.parse(await fs.readFile(source, 'utf-8'));
  } catch {
    return { ok: false, status: 'not_found', message: 'File not found' };
  }
  const myId = uploaderIdFor(roomId, memberHash);
  const allowed = isRoomOwner(config, memberHash) || (!!myId && metadata.uploaderId === myId);
  if (!allowed) return { ok: false, status: 'forbidden', message: 'Only the uploader or the room owner can delete this file' };

  const undoUntil = Date.now() + DELETE_UNDO_MS;
  await fs.mkdir(path.join(roomPath, TRASH_DIR), { recursive: true });
  await fs.writeFile(trashPathOf(roomPath, filename), JSON.stringify({ ...metadata, deletedAt: Date.now(), undoUntil }, null, 2));
  await fs.rm(source, { force: true });
  announceFileRemoved(roomId, filename);

  const key = `${roomId}/${filename}`;
  clearTimeout(pendingDeletes.get(key));
  pendingDeletes.set(
    key,
    setTimeout(() => {
      pendingDeletes.delete(key);
      finalizeDelete(roomPath, filename).catch(err => console.warn('[Room] Finalize delete failed:', err instanceof Error ? err.message : err));
    }, DELETE_UNDO_MS)
  );
  return { ok: true, undoUntil };
}

export async function restoreFile(
  roomId: string,
  roomPath: string,
  config: IRoomConfig,
  memberHash: string | null,
  filename: string
): Promise<{ ok: true; metadata: TFileMetadata } | { ok: false; status: 'forbidden' | 'not_found' | 'conflict'; message: string }> {
  const trashPath = trashPathOf(roomPath, filename);
  let metadata: TFileMetadata & { deletedAt?: number; undoUntil?: number };
  try {
    metadata = JSON.parse(await fs.readFile(trashPath, 'utf-8'));
  } catch {
    return { ok: false, status: 'not_found', message: 'Nothing to restore' };
  }
  const myId = uploaderIdFor(roomId, memberHash);
  const allowed = isRoomOwner(config, memberHash) || (!!myId && metadata.uploaderId === myId);
  if (!allowed) return { ok: false, status: 'forbidden', message: 'Only the person who deleted this file can restore it' };
  if (await exists(metadataPathOf(roomPath, filename))) return { ok: false, status: 'conflict', message: 'A file with this name already exists' };

  const key = `${roomId}/${filename}`;
  clearTimeout(pendingDeletes.get(key));
  pendingDeletes.delete(key);

  const { deletedAt, undoUntil, ...restored } = metadata;
  void deletedAt;
  void undoUntil;
  await fs.writeFile(metadataPathOf(roomPath, filename), JSON.stringify(restored, null, 2));
  await fs.rm(trashPath, { force: true });
  announceFile(roomId, restored, null);
  return { ok: true, metadata: restored };
}

/**
 * Info: (20261106 - Luphia)
 * 真正刪除：移除待刪除區的 metadata，並解除不再被任何檔案引用的分片釘選 (IPFS pin/rm)
 */
async function finalizeDelete(roomPath: string, filename: string) {
  const trashPath = trashPathOf(roomPath, filename);
  let metadata: TFileMetadata;
  try {
    metadata = JSON.parse(await fs.readFile(trashPath, 'utf-8'));
  } catch {
    return;
  }
  await fs.rm(trashPath, { force: true });
  const shards = Array.isArray(metadata.shards) ? (metadata.shards as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  if (shards.length === 0) return;

  // Info: (20261106 - Luphia) 內容相同的分片 CID 相同 (例如全為 0 的填充分片)，仍被其他檔案使用時不可解除
  const referenced = await collectReferencedCids();
  const releasable = [...new Set(shards)].filter(cid => !referenced.has(cid));
  await Promise.all(
    releasable.map(cid =>
      fetch(`${IPFS_API_URL}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: 'POST' }).catch(() => undefined)
    )
  );
}

async function collectReferencedCids(): Promise<Set<string>> {
  const cids = new Set<string>();
  let rooms: string[] = [];
  try {
    rooms = await fs.readdir(ROOM_BASE_DIR);
  } catch {
    return cids;
  }
  for (const roomId of rooms) {
    if (!isValidRoomId(roomId)) continue;
    const roomPath = roomPathOf(roomId);
    const dirs = [roomPath, path.join(roomPath, TRASH_DIR)];
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json') || name === '_config.json') continue;
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
          if (Array.isArray(metadata.shards)) metadata.shards.forEach((c: unknown) => typeof c === 'string' && cids.add(c));
        } catch {
          // Info: (20261106 - Luphia) ignore
        }
      }
    }
  }
  return cids;
}

let lastCleanup = 0;

/**
 * Info: (20261106 - Luphia)
 * 定期清理 (最多每分鐘一次)：過期房間、超過 24 小時沒有檔案且沒人在線的房間、逾時未處理的待刪除檔案
 */
export async function cleanupRooms() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  let rooms: string[] = [];
  try {
    rooms = await fs.readdir(ROOM_BASE_DIR);
  } catch {
    return;
  }
  for (const roomId of rooms) {
    if (!isValidRoomId(roomId)) continue;
    const roomPath = roomPathOf(roomId);
    try {
      const config = await readRoomConfig(roomPath);
      const expiresAt = config.expiration?.expiresAt;
      if (typeof expiresAt === 'number' && now > expiresAt) {
        closeRoom(roomId);
        endCall(roomId);
        await fs.rm(roomPath, { recursive: true, force: true });
        continue;
      }
      // Info: (20261106 - Luphia) 伺服器重啟後遺留的待刪除檔案
      const trashDir = path.join(roomPath, TRASH_DIR);
      for (const name of await fs.readdir(trashDir).catch(() => [] as string[])) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(trashDir, name), 'utf-8'));
          if (typeof meta.undoUntil !== 'number' || now > meta.undoUntil + DELETE_UNDO_MS) {
            await finalizeDelete(roomPath, name.replace(/\.json$/, ''));
          }
        } catch {
          // Info: (20261106 - Luphia) ignore
        }
      }
      const files = await listRoomFiles(roomPath);
      const created = config.createdAt ?? (await fs.stat(roomPath)).mtimeMs;
      if (files.length === 0 && onlineCount(roomId) === 0 && now - created > EMPTY_ROOM_TTL_MS) {
        endCall(roomId);
        await fs.rm(roomPath, { recursive: true, force: true });
      }
    } catch (err) {
      console.warn(`[Room] Cleanup failed for ${roomId}:`, err instanceof Error ? err.message : err);
    }
  }
}
