import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { getCallConfig, issueCallToken } from '@/lib/call_service';
import { resolveCallMember } from '@/lib/call_access';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 POST /api/v1/room/[room_id]/call/token
 * 取得 LiveKit 入場憑證 (Authorization: Bearer <chat token>)
 * 回傳 { url, token, identity, maxParticipants }；人數已滿時回傳 CONFLICT
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  try {
    const { room_id: roomId } = await params;
    const config = getCallConfig();
    if (!config) return jsonFail(ApiCode.NOT_FOUND, 'Calls are not enabled on this server');
    const member = await resolveCallMember(roomId, request);
    if (!member) return jsonFail(ApiCode.UNAUTHORIZED, 'Join the room first');

    const result = await issueCallToken(config, { roomId, ...member });
    if (!result.ok) return jsonFail(ApiCode.CONFLICT, `The call is full (${config.maxParticipants} people)`);
    return jsonOk(result);
  } catch (error) {
    console.error('[Call] Token failed:', error instanceof Error ? error.message : 'unknown');
    return jsonFail(ApiCode.SERVER_ERROR, 'Call service unavailable');
  }
}
