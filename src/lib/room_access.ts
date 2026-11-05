import { promises as fs } from 'fs';
import path from 'path';
import { keccak256, toUtf8Bytes } from 'ethers';
import { ApiCode } from '@/lib/status';

/**
 * Info: (20261105 - Luphia)
 * 房間存取檢查 (伺服器端共用)：房間存在、未過期、密碼正確
 */

export const ROOM_BASE_DIR = path.join(process.cwd(), 'room');

export interface IRoomConfig {
  passwordHash?: string;
  expiration?: {
    expiresAt: number;
    setAt: number;
    minutes: number;
  };
}

export type TRoomAccessResult =
  | { ok: true; roomPath: string; config: IRoomConfig; expiresAt: number | null }
  | { ok: false; code: ApiCode; message: string };

export const isValidRoomId = (roomId: string): boolean => /^\d{6}$/.test(roomId);

export async function readRoomConfig(roomPath: string): Promise<IRoomConfig> {
  try {
    return JSON.parse(await fs.readFile(path.join(roomPath, '_config.json'), 'utf-8')) as IRoomConfig;
  } catch {
    // Info: (20261105 - Luphia) 沒有設定檔或格式錯誤 = 無密碼、無到期時間
    return {};
  }
}

/**
 * Info: (20261105 - Luphia)
 * @param password - 使用者提供的密碼 (null 表示未提供)
 */
export async function checkRoomAccess(roomId: string, password: string | null): Promise<TRoomAccessResult> {
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

  if (config.passwordHash) {
    if (!password) return { ok: false, code: ApiCode.UNAUTHORIZED, message: 'Password required' };
    if (keccak256(toUtf8Bytes(password)) !== config.passwordHash) {
      return { ok: false, code: ApiCode.UNAUTHORIZED, message: 'Invalid password' };
    }
  }

  return { ok: true, roomPath, config, expiresAt };
}
