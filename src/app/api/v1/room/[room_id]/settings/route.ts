import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { getRoomSettings, publicSettings, updateRoomSettings } from '@/lib/room_store';
import { announceRoomSettings, updateRoomTokenExpiry } from '@/lib/chat_hub';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 GET /api/v1/room/[room_id]/settings
 * 房間設定與目前使用者的權限 (是否為房主、能否上傳、自己的上傳者代號)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const memberHash = memberHashFromRequest(request.headers);
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
    if (!access.ok) return jsonFail(access.code, access.message);
    return jsonOk(getRoomSettings(roomId, access.config, memberHash), 'OK', { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Room Settings] Error reading settings:', error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}

/**
 * Info: (20261106 - Luphia) 處理 PATCH /api/v1/room/[room_id]/settings (僅限房主)
 * body: { name?, listed?, uploadPolicy?, allowDownload?, password? (null 移除), minutes? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const memberHash = memberHashFromRequest(request.headers);
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
    if (!access.ok) return jsonFail(access.code, access.message);
    if (!access.isOwner) return jsonFail(ApiCode.FORBIDDEN, 'Only the room owner can change settings');

    let patch: Record<string, unknown>;
    try {
      patch = (await request.json()) ?? {};
    } catch {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
    }

    const updated = await updateRoomSettings(access.roomPath, access.config, patch);
    if ('error' in updated) return jsonFail(ApiCode.VALIDATION_ERROR, updated.error);
    if ('minutes' in patch) updateRoomTokenExpiry(roomId, updated.expiration?.expiresAt ?? null);
    announceRoomSettings(roomId, publicSettings(roomId, updated));
    return jsonOk(getRoomSettings(roomId, updated, memberHash), 'Settings updated');
  } catch (error) {
    console.error('[Room Settings] Error updating settings:', error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
