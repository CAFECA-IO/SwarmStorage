/**
 * Info: (20261106 - Luphia)
 * 瀏覽器端成員身分 (不需註冊)：
 * - 第一次使用時產生 32 bytes 隨機金鑰並存在 localStorage，伺服器只保存其雜湊
 * - 建立房間的瀏覽器即為房主；上傳的檔案以此身分判斷能否刪除
 * - 也記錄最近造訪的房間 (只存房號)
 * 無法使用 localStorage (隱私模式等) 時退回記憶體，重新整理後會變成新身分
 */

const MEMBER_KEY_STORAGE = 'drophere.memberKey';
const RECENT_ROOMS_STORAGE = 'drophere.recentRooms';
const MAX_RECENT_ROOMS = 20;

let memoryKey: string | null = null;
let memoryRecent: string[] = [];

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');

export function getMemberKey(): string {
  try {
    const stored = window.localStorage.getItem(MEMBER_KEY_STORAGE);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) return stored;
    const created = randomHex(32);
    window.localStorage.setItem(MEMBER_KEY_STORAGE, created);
    return created;
  } catch {
    if (!memoryKey) memoryKey = randomHex(32);
    return memoryKey;
  }
}

/**
 * Info: (20261106 - Luphia)
 * 附上成員身分 (與房間密碼) 的請求標頭
 */
export function memberHeaders(extra: Record<string, string> = {}, password?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'x-member-key': getMemberKey(), ...extra };
  if (password) headers['x-room-password'] = password;
  return headers;
}

export function getRecentRooms(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_ROOMS_STORAGE) || '[]');
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string' && /^\d{6}$/.test(n)) : [];
  } catch {
    return memoryRecent;
  }
}

export function addRecentRoom(roomNumber: string) {
  if (!/^\d{6}$/.test(roomNumber)) return;
  const next = [roomNumber, ...getRecentRooms().filter(n => n !== roomNumber)].slice(0, MAX_RECENT_ROOMS);
  memoryRecent = next;
  try {
    window.localStorage.setItem(RECENT_ROOMS_STORAGE, JSON.stringify(next));
  } catch {
    // Info: (20261106 - Luphia) 只保留在記憶體
  }
}
