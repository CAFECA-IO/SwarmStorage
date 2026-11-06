import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { callParticipantCount, getCallConfig } from '@/lib/call_service';
import { resolveCallMember } from '@/lib/call_access';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 GET /api/v1/room/[room_id]/call
 * 通話狀態 (Authorization: Bearer <chat token>)：是否啟用、目前人數、人數上限
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  try {
    const { room_id: roomId } = await params;
    const config = getCallConfig();
    if (!config) return jsonOk({ enabled: false, participants: 0, maxParticipants: 0 });
    const member = await resolveCallMember(roomId, request);
    if (!member) return jsonFail(ApiCode.UNAUTHORIZED, 'Join the room first');
    const participants = await callParticipantCount(config, roomId);
    return jsonOk({ enabled: true, participants, maxParticipants: config.maxParticipants });
  } catch (error) {
    console.error('[Call] Status failed:', error instanceof Error ? error.name : 'unknown');
    return jsonFail(ApiCode.SERVER_ERROR, 'Call service unavailable');
  }
}
