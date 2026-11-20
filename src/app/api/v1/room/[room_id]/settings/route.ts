import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { getRoomSettings, listRoomFiles, publicSettings, updateRoomSettings } from '@/lib/room_store';
import { payInfoFor } from '@/lib/room_paid';
import { ensureWatching, payConfig } from '@/lib/pay_server';
import '@/lib/pay_rooms';
import { DAY_MS, PAID_MIN_DAYS } from '@/lib/pay_plans';
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
    // Info: (20261120 - Luphia) 方案、容量、付費進房與自己的權限 (付費房沒買的人為 locked)
    ensureWatching().catch(() => undefined);
    const pay = await payInfoFor(access.roomPath, access.config, memberHash, await listRoomFiles(access.roomPath), !!payConfig());
    return jsonOk({ ...getRoomSettings(roomId, access.config, memberHash), pay }, 'OK', { headers: { 'Cache-Control': 'no-store' } });
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

    // Info: (20261120 - Luphia) 付費延長或付費房：保存時間不能改短 (付費期間與「最後銷售後 30 天」)
    const now = Date.now();
    const soldRecently = (access.config.paid?.lastSaleAt ?? 0) + PAID_MIN_DAYS * DAY_MS > now;
    if ('minutes' in patch && ((access.config.plan && access.config.plan.until > now) || access.config.paid?.enabled || soldRecently)) {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'This room’s time comes from a paid plan or paid access. Extend it in the Plan tab instead.');
    }
    if (access.config.paid?.enabled && patch.uploadPolicy === 'everyone') {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Only the owner can upload to a paid room');
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
