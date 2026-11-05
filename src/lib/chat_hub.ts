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

export type TChatEvent =
  | { type: 'ready'; me: IChatMember; online: number; members: IChatMember[] }
  | { type: 'message'; message: IChatMessage }
  | { type: 'presence'; action: 'join' | 'leave'; member: IChatMember; online: number }
  | { type: 'expired' }
  | { type: 'error'; message: string };

interface IChatToken extends IChatMember {
  roomId: string;
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
}

// Info: (20261105 - Luphia) 掛在 globalThis，避免開發模式熱更新時產生多份狀態
const globalForChat = globalThis as unknown as { drophereChatHub?: IChatHubState };
const state: IChatHubState = globalForChat.drophereChatHub ?? { tokens: new Map(), rooms: new Map() };
globalForChat.drophereChatHub = state;

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
export function issueChatToken(roomId: string, roomExpiresAt: number | null): { token: string; member: IChatMember; expiresAt: number } {
  purgeExpiredTokens();
  const expiresAt = Math.min(roomExpiresAt ?? Number.POSITIVE_INFINITY, Date.now() + TOKEN_MAX_TTL_MS);
  const taken = new Set(membersOf(roomId).map(m => m.nickname));
  let nickname = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  for (let i = 0; i < 10 && taken.has(nickname); i++) nickname = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  if (taken.has(nickname)) nickname = `${nickname} ${Math.floor(Math.random() * 90) + 10}`;

  const token = randomBytes(24).toString('base64url');
  const member: IChatMember = { memberId: randomUUID(), nickname };
  state.tokens.set(token, { ...member, roomId, expiresAt, sentAt: [] });
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
  send({ type: 'ready', me, online: members.length, members });
  if (!wasOnline) broadcast(roomId, { type: 'presence', action: 'join', member: me, online: members.length });

  return {
    unsubscribe: () => {
      const current = state.rooms.get(roomId);
      if (!current?.delete(connection.id)) return;
      if (current.size === 0) state.rooms.delete(roomId);
      if (!isMemberOnline(roomId, entry.memberId)) {
        broadcast(roomId, { type: 'presence', action: 'leave', member: me, online: membersOf(roomId).length });
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
  state.tokens.forEach((token, key) => {
    if (token.roomId === roomId) state.tokens.delete(key);
  });
}

export function onlineCount(roomId: string): number {
  return membersOf(roomId).length;
}
