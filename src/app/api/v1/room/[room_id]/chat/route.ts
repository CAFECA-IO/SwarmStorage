import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { isValidRoomId } from '@/lib/room_access';
import { CHAT_MAX_LENGTH, publish } from '@/lib/chat_hub';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261105 - Luphia) 處理 POST /api/v1/room/[room_id]/chat
 * Authorization: Bearer <chat token>，body: { text }
 * 訊息只轉發給在線成員，不儲存、不記錄內容
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

    let text: unknown = null;
    try {
      text = (await request.json())?.text;
    } catch {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
    }

    const result = publish(roomId, token, text);
    if (!result.ok) {
      if (result.reason === 'token') return jsonFail(ApiCode.UNAUTHORIZED, 'Invalid or expired chat token');
      if (result.reason === 'rate') return jsonFail(ApiCode.RATE_LIMIT, 'Too many messages, slow down');
      return jsonFail(ApiCode.VALIDATION_ERROR, `Message must be 1-${CHAT_MAX_LENGTH} characters`);
    }

    return jsonOk({ id: result.message.id, sentAt: result.message.sentAt });
  } catch (error) {
    // Info: (20261105 - Luphia) 只記錄錯誤類型，不記錄訊息內容
    console.error('[Chat] Send failed:', error instanceof Error ? error.name : 'unknown');
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
