import { NextRequest, NextResponse } from 'next/server';
import { announceCall } from '@/lib/chat_hub';
import { getCallConfig, invalidateParticipantCount, listCallParticipants, receiveWebhook, roomIdFromCallRoom, setCachedParticipantCount } from '@/lib/call_service';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 POST /api/v1/livekit/webhook
 * LiveKit 事件 (以 API secret 驗證簽章)：通話人數變更時即時通知房間成員
 * 共用 LiveKit 時會收到其他服務 (Hills) 的事件，依房間名稱前綴略過
 */
export async function POST(request: NextRequest) {
  const config = getCallConfig();
  if (!config) return new NextResponse(null, { status: 404 });
  let event;
  try {
    event = await receiveWebhook(config, await request.text(), request.headers.get('authorization'));
  } catch {
    return new NextResponse(null, { status: 401 });
  }

  const roomId = roomIdFromCallRoom(config, event.room?.name);
  if (!roomId) return new NextResponse(null, { status: 204 });

  if (event.event === 'room_finished') {
    setCachedParticipantCount(roomId, 0);
    announceCall(roomId, 0);
  } else if (event.event === 'participant_joined' || event.event === 'participant_left') {
    // Info: (20261106 - Luphia) 事件附帶的房間人數可能尚未更新，改以 LiveKit API 查詢；離開事件需排除離開者
    invalidateParticipantCount(roomId);
    const leaving = event.event === 'participant_left' ? event.participant?.identity : undefined;
    const list = await listCallParticipants(config, roomId).catch(() => null);
    if (list) {
      const count = list.filter(p => p.identity !== leaving).length;
      setCachedParticipantCount(roomId, count);
      announceCall(roomId, count);
    }
  }
  return new NextResponse(null, { status: 204 });
}
