import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { getCallConfig, moderateCall } from '@/lib/call_service';
import { resolveCallMember } from '@/lib/call_access';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 POST /api/v1/room/[room_id]/call/moderate
 * 房主關閉某人的麥克風或請對方離開通話
 * body: { identity, action: 'mute' | 'remove' }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  try {
    const { room_id: roomId } = await params;
    const config = getCallConfig();
    if (!config) return jsonFail(ApiCode.NOT_FOUND, 'Calls are not enabled on this server');
    const member = await resolveCallMember(roomId, request);
    if (!member) return jsonFail(ApiCode.UNAUTHORIZED, 'Join the room first');
    if (!member.isOwner) return jsonFail(ApiCode.FORBIDDEN, 'Only the room owner can do this');

    let body: { identity?: unknown; action?: unknown };
    try {
      body = await request.json();
    } catch {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
    }
    const { identity, action } = body ?? {};
    if (typeof identity !== 'string' || !/^[\w-]{1,64}$/.test(identity) || (action !== 'mute' && action !== 'remove')) {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid request');
    }
    if (identity === member.identity) return jsonFail(ApiCode.VALIDATION_ERROR, 'Use the call controls for yourself');

    const done = await moderateCall(config, roomId, identity, action);
    if (!done) return jsonFail(ApiCode.NOT_FOUND, 'That person is no longer in the call');
    return jsonOk(null);
  } catch (error) {
    console.error('[Call] Moderate failed:', error instanceof Error ? error.name : 'unknown');
    return jsonFail(ApiCode.SERVER_ERROR, 'Call service unavailable');
  }
}
