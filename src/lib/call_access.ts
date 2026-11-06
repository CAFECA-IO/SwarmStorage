import path from 'path';
import type { NextRequest } from 'next/server';
import { resolveChatToken } from '@/lib/chat_hub';
import { ROOM_BASE_DIR, isRoomOwner, isValidRoomId, readRoomConfig, uploaderIdFor } from '@/lib/room_access';

export interface ICallMember {
  identity: string;
  name: string;
  isOwner: boolean;
  roomExpiresAt: number | null;
}

/**
 * Info: (20261106 - Luphia)
 * 通話 API 共用的身分檢查：必須持有房間聊天 token (代表已通過密碼 / 到期檢查)
 * identity 使用房間內的匿名代號 (與檔案上傳者代號相同)，暱稱沿用聊天暱稱
 */
export async function resolveCallMember(roomId: string, request: NextRequest): Promise<ICallMember | null> {
  if (!isValidRoomId(roomId)) return null;
  const auth = request.headers.get('authorization') || '';
  const entry = resolveChatToken(roomId, auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
  if (!entry) return null;
  const config = await readRoomConfig(path.join(ROOM_BASE_DIR, roomId));
  const expiresAt = config.expiration?.expiresAt ?? null;
  if (expiresAt !== null && expiresAt <= Date.now()) return null;
  return {
    identity: uploaderIdFor(roomId, entry.memberHash) ?? `guest-${entry.memberId.replace(/-/g, '').slice(0, 12)}`,
    name: entry.nickname,
    isOwner: isRoomOwner(config, entry.memberHash),
    roomExpiresAt: expiresAt,
  };
}
