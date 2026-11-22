import { NextRequest } from 'next/server';
import { jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { accountMemberHash, sessionFromHeaders } from '@/lib/auth_session';
import { MAX_OWNER_STREAMS, ownerStreamCount, subscribeOwner, type TOwnerEvent } from '@/lib/owner_earnings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25000;

/**
 * Info: (20261122 - Luphia) GET /api/v1/me/events (CAFECA 登入，以 cookie 驗證)
 * Server-Sent Events：房主的新銷售；每 25 秒送出心跳
 */
export async function GET(request: NextRequest) {
  const session = sessionFromHeaders(request.headers);
  if (!session) return jsonFail(ApiCode.UNAUTHORIZED, 'Sign in with CAFECA first');
  const memberHash = accountMemberHash(session.account);
  if (ownerStreamCount(memberHash) >= MAX_OWNER_STREAMS) return jsonFail(ApiCode.RATE_LIMIT, 'Too many open tabs');

  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop();
        }
      };
      const unsubscribe = subscribeOwner(memberHash, (event: TOwnerEvent) => write(`data: ${JSON.stringify(event)}\n\n`));
      const heartbeat = setInterval(() => {
        write(': ping\n\n');
        // Info: (20261122 - Luphia) 登入過期：結束串流 (客戶端重新讀取登入狀態)
        if (session.expiresAt <= Date.now() / 1000) stop();
      }, HEARTBEAT_MS);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Info: (20261122 - Luphia) 已關閉
        }
      };
      write('retry: 5000\n\n');
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
      'X-Accel-Buffering': 'no',
    },
  });
}
