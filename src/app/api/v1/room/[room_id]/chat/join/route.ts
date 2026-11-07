import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { issueChatToken, onlineCount } from '@/lib/chat_hub';
import { sessionFromHeaders } from '@/lib/auth_session';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261105 - Luphia) 處理 POST /api/v1/room/[room_id]/chat/join
 * 驗證房間密碼與到期時間後，發給聊天 token 與匿名暱稱
 * (EventSource 無法帶自訂標頭，因此改用 token 連線)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const memberHash = memberHashFromRequest(request.headers);
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
    if (!access.ok) return jsonFail(access.code, access.message);

    // Info: (20261108 - Luphia) 以 CAFECA 登入且同意提供代稱時，以代稱作為暱稱
    const handle = sessionFromHeaders(request.headers)?.handle ?? null;
    const { token, member, expiresAt } = issueChatToken(roomId, access.expiresAt, memberHash, handle);
    return jsonOk({ token, ...member, expiresAt, online: onlineCount(roomId) }, 'OK', {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[Chat] Join failed:', error instanceof Error ? error.message : error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
