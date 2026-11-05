import path from 'path';
import { NextRequest } from 'next/server';
import { jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { ROOM_BASE_DIR, isValidRoomId, readRoomConfig } from '@/lib/room_access';
import { closeRoom, resolveChatToken, subscribe, type TChatEvent } from '@/lib/chat_hub';
import { promises as fs } from 'fs';

export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 25000;

/**
 * Info: (20261105 - Luphia)
 * 房間是否仍然有效 (存在且未過期)；聊天 token 過期時用來判斷要結束房間還是讓客戶端重新加入
 */
async function isRoomAlive(roomId: string): Promise<boolean> {
  const roomPath = path.join(ROOM_BASE_DIR, roomId);
  try {
    await fs.access(roomPath);
  } catch {
    return false;
  }
  const config = await readRoomConfig(roomPath);
  const expiresAt = config.expiration?.expiresAt;
  return typeof expiresAt !== 'number' || Date.now() <= expiresAt;
}

/**
 * Info: (20261105 - Luphia) 處理 GET /api/v1/room/[room_id]/chat/stream?token=
 * Server-Sent Events：推送訊息、成員進出與在線人數；每 25 秒送出心跳
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  const { room_id: roomId } = await params;
  const token = request.nextUrl.searchParams.get('token');
  if (!isValidRoomId(roomId)) return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid room number');
  if (!token || !resolveChatToken(roomId, token)) {
    return jsonFail(ApiCode.UNAUTHORIZED, 'Invalid or expired chat token');
  }

  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const timers: { heartbeat?: ReturnType<typeof setInterval> } = {};
      let unsubscribe = () => {};

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      const sendEvent = (event: TChatEvent) => write(`data: ${JSON.stringify(event)}\n\n`);

      stop = () => {
        if (closed) return;
        closed = true;
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Info: (20261105 - Luphia) 已關閉
        }
      };

      // Info: (20261105 - Luphia) 告訴瀏覽器斷線 3 秒後重連
      write('retry: 3000\n\n');

      const subscription = subscribe(roomId, token, sendEvent, () => stop());
      if ('error' in subscription) {
        sendEvent({ type: 'error', message: subscription.error });
        stop();
        return;
      }
      unsubscribe = subscription.unsubscribe;

      timers.heartbeat = setInterval(async () => {
        write(': ping\n\n');
        if (resolveChatToken(roomId, token)) return;
        // Info: (20261105 - Luphia) token 已過期：房間也過期則通知所有人；否則關閉此連線，讓客戶端重新加入
        if (await isRoomAlive(roomId)) stop();
        else closeRoom(roomId);
      }, HEARTBEAT_MS);

      request.signal.addEventListener('abort', () => stop());
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      // Info: (20261105 - Luphia) 避免 Nginx 等反向代理暫存串流
      'X-Accel-Buffering': 'no',
    },
  });
}
