import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import path from 'path';
import { ROOM_BASE_DIR, canUpload, isValidRoomId, readRoomConfig } from '@/lib/room_access';
import { reportUpload, resolveChatToken, type IUploadReport } from '@/lib/chat_hub';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261105 - Luphia) 處理 POST /api/v1/room/[room_id]/uploads
 * 上傳者回報上傳進度 (Authorization: Bearer <chat token>)
 * body: { uploadId, filename, size, mimeType, shardsDone, shardsTotal, status: 'uploading' | 'failed' | 'cancelled' }
 * 狀態只保存在記憶體，並即時推送給房間內的其他成員
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    if (!isValidRoomId(roomId)) return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid room number');

    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

    let report: IUploadReport;
    try {
      report = (await request.json()) as IUploadReport;
    } catch {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
    }

    // Info: (20261106 - Luphia) 依房間上傳權限檢查 (只有房主可上傳的房間)
    const entry = resolveChatToken(roomId, token);
    if (entry && report?.status === 'uploading') {
      const config = await readRoomConfig(path.join(ROOM_BASE_DIR, roomId));
      if (!canUpload(config, entry.memberHash)) return jsonFail(ApiCode.FORBIDDEN, 'Only the room owner can upload');
    }

    const result = reportUpload(roomId, token, report || {});
    if (!result.ok) {
      if (result.reason === 'token') return jsonFail(ApiCode.UNAUTHORIZED, 'Invalid or expired room token');
      if (result.reason === 'forbidden') return jsonFail(ApiCode.FORBIDDEN, 'This upload belongs to another member');
      if (result.reason === 'limit') return jsonFail(ApiCode.RATE_LIMIT, 'Too many uploads in progress');
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid upload report');
    }
    return jsonOk(null);
  } catch (error) {
    console.error('[Uploads] Report failed:', error instanceof Error ? error.name : 'unknown');
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
