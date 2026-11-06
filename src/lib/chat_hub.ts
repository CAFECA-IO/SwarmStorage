import { randomBytes, randomUUID } from 'crypto';

/**
 * Info: (20261105 - Luphia)
 * 房間即時聊天的記憶體轉發中心 (單一 Node 程序)
 * - 訊息只轉發給當下在線的連線，不寫入檔案、IPFS 或 log，也不保留歷史
 * - token 只存在記憶體；程序重啟後客戶端會自動重新加入
 * - 若未來改為多程序部署，只需替換 publish / subscribe 的實作 (例如 Redis 或 IPFS pubsub)
 */

export const CHAT_MAX_LENGTH = 1000;
const RATE_WINDOW_MS = 5000;
const RATE_MAX_MESSAGES = 5;
// Info: (20261105 - Luphia) 房間未設定到期時間時，token 最長有效期
const TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEMBERS_PER_ROOM = 200;

const ADJECTIVES = ['Blue', 'Swift', 'Quiet', 'Bright', 'Amber', 'Silver', 'Lucky', 'Brave', 'Calm', 'Clever', 'Gentle', 'Misty', 'Sunny', 'Wild', 'Cosmic', 'Jade'];
const ANIMALS = ['Fox', 'Owl', 'Otter', 'Panda', 'Falcon', 'Lynx', 'Koala', 'Heron', 'Tiger', 'Whale', 'Badger', 'Crane', 'Gecko', 'Hare', 'Moth', 'Robin'];

export interface IChatMember {
  memberId: string;
  nickname: string;
}

export interface IChatMessage extends IChatMember {
  id: string;
  text: string;
  sentAt: number;
}

// Info: (20261105 - Luphia) 上傳中的檔案 (僅存在記憶體，供房間內其他人即時看到進度)
export interface IUploadStatus {
  uploadId: string;
  filename: string;
  size: number;
  mimeType: string;
  uploader: IChatMember;
  shardsDone: number;
  shardsTotal: number;
  startedAt: number;
  updatedAt: number;
  status: 'uploading' | 'interrupted';
}

export type TChatEvent =
  | { type: 'ready'; me: IChatMember; online: number; members: IChatMember[]; uploads: IUploadStatus[] }
  | { type: 'upload'; upload: IUploadStatus }
  | { type: 'upload-removed'; uploadId: string; reason: 'failed' | 'cancelled' | 'interrupted' }
  | { type: 'file'; metadata: Record<string, unknown>; uploadId: string | null }
  | { type: 'file-removed'; filename: string }
  | { type: 'room-settings'; settings: Record<string, unknown> }
  | { type: 'message'; message: IChatMessage }
  | { type: 'presence'; action: 'join' | 'leave'; member: IChatMember; online: number }
  | { type: 'expired' }
  | { type: 'error'; message: string };

interface IChatToken extends IChatMember {
  roomId: string;
  // Info: (20261106 - Luphia) 成員身分 (瀏覽器金鑰雜湊)，用於上傳權限判斷；未提供時為 null
  memberHash: string | null;
  expiresAt: number;
  sentAt: number[];
}

interface IChatConnection {
  id: string;
  token: string;
  send: (event: TChatEvent) => void;
  close: () => void;
}

interface IChatHubState {
  tokens: Map<string, IChatToken>;
  rooms: Map<string, Map<string, IChatConnection>>;
  uploads: Map<string, Map<string, IUploadStatus>>;
  sweeper?: ReturnType<typeof setInterval>;
}

// Info: (20261105 - Luphia) 掛在 globalThis，避免開發模式熱更新時產生多份狀態
const globalForChat = globalThis as unknown as { drophereChatHub?: IChatHubState };
const state: IChatHubState = globalForChat.drophereChatHub ?? { tokens: new Map(), rooms: new Map(), uploads: new Map() };
if (!state.uploads) state.uploads = new Map();
globalForChat.drophereChatHub = state;

// Info: (20261105 - Luphia) 上傳進度：超過 60 秒沒有更新視為中斷，中斷 30 秒後移除
const UPLOAD_STALE_MS = 60 * 1000;
const UPLOAD_INTERRUPTED_TTL_MS = 30 * 1000;
const UPLOAD_SWEEP_MS = 10 * 1000;
const MAX_UPLOADS_PER_ROOM = 50;
const MAX_FILENAME_LENGTH = 255;

const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

const purgeExpiredTokens = () => {
  const now = Date.now();
  state.tokens.forEach((token, key) => {
    if (token.expiresAt <= now) state.tokens.delete(key);
  });
};

const membersOf = (roomId: string): IChatMember[] => {
  const seen = new Map<string, IChatMember>();
  state.rooms.get(roomId)?.forEach(conn => {
    const token = state.tokens.get(conn.token);
    if (token && !seen.has(token.memberId)) seen.set(token.memberId, { memberId: token.memberId, nickname: token.nickname });
  });
  return [...seen.values()];
};

const isMemberOnline = (roomId: string, memberId: string): boolean => {
  for (const conn of state.rooms.get(roomId)?.values() ?? []) {
    if (state.tokens.get(conn.token)?.memberId === memberId) return true;
  }
  return false;
};

const broadcast = (roomId: string, event: TChatEvent) => {
  state.rooms.get(roomId)?.forEach(conn => {
    try {
      conn.send(event);
    } catch {
      // Info: (20261105 - Luphia) 連線已關閉，由 unsubscribe 清理
    }
  });
};

/**
 * Info: (20261105 - Luphia)
 * 加入房間聊天，取得 token 與系統配發的匿名暱稱
 */
export function issueChatToken(
  roomId: string,
  roomExpiresAt: number | null,
  memberHash: string | null = null
): { token: string; member: IChatMember; expiresAt: number } {
  purgeExpiredTokens();
  const expiresAt = Math.min(roomExpiresAt ?? Number.POSITIVE_INFINITY, Date.now() + TOKEN_MAX_TTL_MS);
  const taken = new Set(membersOf(roomId).map(m => m.nickname));
  let nickname = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  for (let i = 0; i < 10 && taken.has(nickname); i++) nickname = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  if (taken.has(nickname)) nickname = `${nickname} ${Math.floor(Math.random() * 90) + 10}`;

  const token = randomBytes(24).toString('base64url');
  const member: IChatMember = { memberId: randomUUID(), nickname };
  state.tokens.set(token, { ...member, roomId, memberHash, expiresAt, sentAt: [] });
  return { token, member, expiresAt };
}

export function resolveChatToken(roomId: string, token: string | null): IChatToken | null {
  if (!token) return null;
  const entry = state.tokens.get(token);
  if (!entry || entry.roomId !== roomId) return null;
  if (entry.expiresAt <= Date.now()) {
    state.tokens.delete(token);
    return null;
  }
  return entry;
}

/**
 * Info: (20261105 - Luphia)
 * 延長房間內所有 token 的有效期 (房主延長保存時間後呼叫)
 */
export function updateRoomTokenExpiry(roomId: string, roomExpiresAt: number | null) {
  const cap = Date.now() + TOKEN_MAX_TTL_MS;
  state.tokens.forEach(token => {
    if (token.roomId === roomId) token.expiresAt = Math.min(roomExpiresAt ?? Number.POSITIVE_INFINITY, cap);
  });
}

export function subscribe(
  roomId: string,
  token: string,
  send: (event: TChatEvent) => void,
  close: () => void
): { unsubscribe: () => void } | { error: string } {
  const entry = resolveChatToken(roomId, token);
  if (!entry) return { error: 'Invalid or expired chat token' };

  let room = state.rooms.get(roomId);
  if (!room) {
    room = new Map();
    state.rooms.set(roomId, room);
  }
  const wasOnline = isMemberOnline(roomId, entry.memberId);
  if (!wasOnline && membersOf(roomId).length >= MAX_MEMBERS_PER_ROOM) return { error: 'Room chat is full' };

  const connection: IChatConnection = { id: randomUUID(), token, send, close };
  room.set(connection.id, connection);

  const me: IChatMember = { memberId: entry.memberId, nickname: entry.nickname };
  const members = membersOf(roomId);
  send({ type: 'ready', me, online: members.length, members, uploads: uploadsOf(roomId) });
  if (!wasOnline) broadcast(roomId, { type: 'presence', action: 'join', member: me, online: members.length });

  return {
    unsubscribe: () => {
      const current = state.rooms.get(roomId);
      if (!current?.delete(connection.id)) return;
      if (current.size === 0) state.rooms.delete(roomId);
      if (!isMemberOnline(roomId, entry.memberId)) {
        broadcast(roomId, { type: 'presence', action: 'leave', member: me, online: membersOf(roomId).length });
        // Info: (20261105 - Luphia) 上傳者離開：其未完成的上傳標示為中斷
        markMemberUploadsInterrupted(roomId, entry.memberId);
      }
    },
  };
}

export type TPublishResult = { ok: true; message: IChatMessage } | { ok: false; reason: 'token' | 'rate' | 'length' };

/**
 * Info: (20261105 - Luphia)
 * 發送訊息：驗證 token、長度與頻率後廣播，訊息內容不留存
 */
export function publish(roomId: string, token: string | null, rawText: unknown): TPublishResult {
  const entry = resolveChatToken(roomId, token);
  if (!entry) return { ok: false, reason: 'token' };

  const text = typeof rawText === 'string' ? rawText.replace(/\r\n?/g, '\n').trim() : '';
  if (!text || text.length > CHAT_MAX_LENGTH) return { ok: false, reason: 'length' };

  const now = Date.now();
  entry.sentAt = entry.sentAt.filter(t => now - t < RATE_WINDOW_MS);
  if (entry.sentAt.length >= RATE_MAX_MESSAGES) return { ok: false, reason: 'rate' };
  entry.sentAt.push(now);

  const message: IChatMessage = { id: randomUUID(), memberId: entry.memberId, nickname: entry.nickname, text, sentAt: now };
  broadcast(roomId, { type: 'message', message });
  return { ok: true, message };
}

/**
 * Info: (20261105 - Luphia)
 * 房間到期：通知所有連線並關閉，清除 token
 */
export function closeRoom(roomId: string) {
  const room = state.rooms.get(roomId);
  room?.forEach(conn => {
    try {
      conn.send({ type: 'expired' });
      conn.close();
    } catch {
      // Info: (20261105 - Luphia) ignore
    }
  });
  state.rooms.delete(roomId);
  state.uploads.delete(roomId);
  state.tokens.forEach((token, key) => {
    if (token.roomId === roomId) state.tokens.delete(key);
  });
}

export function onlineCount(roomId: string): number {
  return membersOf(roomId).length;
}

// --- Info: (20261105 - Luphia) 即時上傳狀態 ---

const uploadsOf = (roomId: string): IUploadStatus[] =>
  [...(state.uploads.get(roomId)?.values() ?? [])].sort((a, b) => a.startedAt - b.startedAt);

function markMemberUploadsInterrupted(roomId: string, memberId: string) {
  state.uploads.get(roomId)?.forEach(upload => {
    if (upload.uploader.memberId === memberId && upload.status === 'uploading') {
      upload.status = 'interrupted';
      upload.updatedAt = Date.now();
      broadcast(roomId, { type: 'upload', upload });
    }
  });
}

function removeUpload(roomId: string, uploadId: string, reason: 'failed' | 'cancelled' | 'interrupted', notify = true) {
  const room = state.uploads.get(roomId);
  if (!room?.delete(uploadId)) return;
  if (room.size === 0) state.uploads.delete(roomId);
  if (notify) broadcast(roomId, { type: 'upload-removed', uploadId, reason });
}

const sweepUploads = () => {
  const now = Date.now();
  state.uploads.forEach((room, roomId) => {
    room.forEach(upload => {
      if (upload.status === 'uploading' && now - upload.updatedAt > UPLOAD_STALE_MS) {
        upload.status = 'interrupted';
        upload.updatedAt = now;
        broadcast(roomId, { type: 'upload', upload });
      } else if (upload.status === 'interrupted' && now - upload.updatedAt > UPLOAD_INTERRUPTED_TTL_MS) {
        removeUpload(roomId, upload.uploadId, 'interrupted');
      }
    });
  });
};

if (!state.sweeper) {
  state.sweeper = setInterval(sweepUploads, UPLOAD_SWEEP_MS);
  // Info: (20261105 - Luphia) 不阻止 Node 程序結束
  state.sweeper.unref?.();
}

export interface IUploadReport {
  uploadId?: unknown;
  filename?: unknown;
  size?: unknown;
  mimeType?: unknown;
  shardsDone?: unknown;
  shardsTotal?: unknown;
  status?: unknown;
}

export type TUploadReportResult = { ok: true } | { ok: false; reason: 'token' | 'invalid' | 'limit' | 'forbidden' };

/**
 * Info: (20261105 - Luphia)
 * 上傳者回報進度：開始 / 進行中 (uploading)、失敗 (failed)、取消 (cancelled)
 * 只有發起上傳的成員可以更新同一個 uploadId
 */
export function reportUpload(roomId: string, token: string | null, report: IUploadReport): TUploadReportResult {
  const entry = resolveChatToken(roomId, token);
  if (!entry) return { ok: false, reason: 'token' };

  const uploadId = typeof report.uploadId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(report.uploadId) ? report.uploadId : null;
  if (!uploadId) return { ok: false, reason: 'invalid' };

  let room = state.uploads.get(roomId);
  const existing = room?.get(uploadId);
  if (existing && existing.uploader.memberId !== entry.memberId) return { ok: false, reason: 'forbidden' };

  if (report.status === 'failed' || report.status === 'cancelled') {
    if (existing) removeUpload(roomId, uploadId, report.status);
    return { ok: true };
  }
  if (report.status !== 'uploading') return { ok: false, reason: 'invalid' };

  const filename = typeof report.filename === 'string' ? report.filename.trim() : '';
  const size = Number(report.size);
  const shardsTotal = Number(report.shardsTotal);
  const shardsDone = Number(report.shardsDone);
  if (
    !filename ||
    filename.length > MAX_FILENAME_LENGTH ||
    !Number.isFinite(size) ||
    size < 0 ||
    !Number.isInteger(shardsTotal) ||
    shardsTotal < 0 ||
    !Number.isInteger(shardsDone) ||
    shardsDone < 0 ||
    shardsDone > shardsTotal
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const now = Date.now();
  if (existing) {
    // Info: (20261105 - Luphia) 進度只增不減
    existing.shardsDone = Math.max(existing.shardsDone, shardsDone);
    existing.updatedAt = now;
    existing.status = 'uploading';
    broadcast(roomId, { type: 'upload', upload: existing });
    return { ok: true };
  }

  if (!room) {
    room = new Map();
    state.uploads.set(roomId, room);
  }
  if (room.size >= MAX_UPLOADS_PER_ROOM) return { ok: false, reason: 'limit' };

  const upload: IUploadStatus = {
    uploadId,
    filename,
    size,
    mimeType: typeof report.mimeType === 'string' ? report.mimeType.slice(0, 127) : '',
    uploader: { memberId: entry.memberId, nickname: entry.nickname },
    shardsDone,
    shardsTotal,
    startedAt: now,
    updatedAt: now,
    status: 'uploading',
  };
  room.set(uploadId, upload);
  broadcast(roomId, { type: 'upload', upload });
  return { ok: true };
}

/**
 * Info: (20261105 - Luphia)
 * 房間新增或更新檔案 metadata 時通知在線成員；若對應某個上傳則一併結束該上傳
 */
export function announceFile(roomId: string, metadata: Record<string, unknown>, uploadId: string | null) {
  if (uploadId) removeUpload(roomId, uploadId, 'cancelled', false);
  broadcast(roomId, { type: 'file', metadata, uploadId });
}

/**
 * Info: (20261106 - Luphia)
 * 檔案被移除 (或移入待刪除區) 時通知在線成員
 */
export function announceFileRemoved(roomId: string, filename: string) {
  broadcast(roomId, { type: 'file-removed', filename });
}

/**
 * Info: (20261106 - Luphia)
 * 房間設定變更 (名稱、公開、上傳權限、密碼、到期) 時通知在線成員
 */
export function announceRoomSettings(roomId: string, settings: Record<string, unknown>) {
  broadcast(roomId, { type: 'room-settings', settings });
}

export function uploadingCount(roomId: string): number {
  return [...(state.uploads.get(roomId)?.values() ?? [])].filter(u => u.status === 'uploading').length;
}
