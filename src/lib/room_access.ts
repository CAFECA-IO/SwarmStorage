import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { accountMemberHash, sessionFromHeaders } from '@/lib/auth_session';
import { keccak256, toUtf8Bytes } from 'ethers';
import { ApiCode } from '@/lib/status';

/**
 * Info: (20261105 - Luphia)
 * 房間存取檢查 (伺服器端共用)：房間存在、未過期、密碼正確
 * Info: (20261106 - Luphia) 加入房間設定 (名稱、公開、上傳權限) 與成員身分 (瀏覽器金鑰的雜湊)
 */

export const ROOM_BASE_DIR = path.join(process.cwd(), 'room');

export type TUploadPolicy = 'owner' | 'everyone';

export interface IRoomConfig {
  name?: string;
  // Info: (20261106 - Luphia) 是否出現在首頁清單；舊房間未設定時視為不公開
  listed?: boolean;
  // Info: (20261106 - Luphia) 誰可以上傳；舊房間未設定時視為所有人
  uploadPolicy?: TUploadPolicy;
  // Info: (20261106 - Luphia) 新上傳檔案預設是否允許下載
  allowDownload?: boolean;
  // Info: (20261106 - Luphia) 建立者瀏覽器金鑰的 SHA-256；舊房間沒有建立者
  ownerHash?: string;
  createdAt?: number;
  passwordHash?: string;
  expiration?: {
    expiresAt: number;
    setAt: number;
    minutes: number;
  };
}

export type TRoomAccessResult =
  | { ok: true; roomPath: string; config: IRoomConfig; expiresAt: number | null; isOwner: boolean }
  | { ok: false; code: ApiCode; message: string };

export const isValidRoomId = (roomId: string): boolean => /^\d{6}$/.test(roomId);

/**
 * Info: (20261106 - Luphia)
 * 成員身分：瀏覽器產生的隨機金鑰 (64 字元 hex)，伺服器只保存其雜湊
 */
export const hashMemberKey = (key: string | null | undefined): string | null =>
  key && /^[0-9a-f]{64}$/i.test(key) ? createHash('sha256').update(key.toLowerCase()).digest('hex') : null;

/**
 * Info: (20261108 - Luphia)
 * 請求者的成員身分：以 CAFECA 登入時使用帳戶身分 (換裝置仍相同)，否則使用瀏覽器金鑰
 */
export const memberHashFromRequest = (headers: Headers): string | null => {
  const session = sessionFromHeaders(headers);
  return session ? accountMemberHash(session.account) : hashMemberKey(headers.get('x-member-key'));
};

// Info: (20261106 - Luphia) 每個房間各自的上傳者代號 (公開)，無法反推金鑰，也無法跨房間比對
export const uploaderIdFor = (roomId: string, memberHash: string | null): string | null =>
  memberHash ? createHash('sha256').update(`${roomId}:${memberHash}`).digest('hex').slice(0, 16) : null;

export const isRoomOwner = (config: IRoomConfig, memberHash: string | null): boolean =>
  !!config.ownerHash && !!memberHash && config.ownerHash === memberHash;

export const canUpload = (config: IRoomConfig, memberHash: string | null): boolean =>
  config.uploadPolicy !== 'owner' || isRoomOwner(config, memberHash);

export const hashPassword = (password: string): string => keccak256(toUtf8Bytes(password));

export async function readRoomConfig(roomPath: string): Promise<IRoomConfig> {
  try {
    return JSON.parse(await fs.readFile(path.join(roomPath, '_config.json'), 'utf-8')) as IRoomConfig;
  } catch {
    // Info: (20261105 - Luphia) 沒有設定檔或格式錯誤 = 無密碼、無到期時間
    return {};
  }
}

export async function writeRoomConfig(roomPath: string, config: IRoomConfig): Promise<void> {
  await fs.writeFile(path.join(roomPath, '_config.json'), JSON.stringify(config, null, 2));
}

/**
 * Info: (20261105 - Luphia)
 * @param password - 使用者提供的密碼 (null 表示未提供)
 * @param memberHash - 成員身分；房間建立者不需輸入密碼
 */
export async function checkRoomAccess(
  roomId: string,
  password: string | null,
  memberHash: string | null = null
): Promise<TRoomAccessResult> {
  if (!isValidRoomId(roomId)) {
    return { ok: false, code: ApiCode.VALIDATION_ERROR, message: 'Invalid room number' };
  }
  const roomPath = path.join(ROOM_BASE_DIR, roomId);
  try {
    await fs.access(roomPath);
  } catch {
    return { ok: false, code: ApiCode.NOT_FOUND, message: 'Room not found' };
  }

  const config = await readRoomConfig(roomPath);
  const expiresAt = typeof config.expiration?.expiresAt === 'number' ? config.expiration.expiresAt : null;
  if (expiresAt !== null && Date.now() > expiresAt) {
    return { ok: false, code: ApiCode.NOT_FOUND, message: 'Room expired' };
  }

  const isOwner = isRoomOwner(config, memberHash);
  if (config.passwordHash && !isOwner) {
    if (!password) return { ok: false, code: ApiCode.UNAUTHORIZED, message: 'Password required' };
    if (hashPassword(password) !== config.passwordHash) {
      return { ok: false, code: ApiCode.UNAUTHORIZED, message: 'Invalid password' };
    }
  }

  return { ok: true, roomPath, config, expiresAt, isOwner };
}
