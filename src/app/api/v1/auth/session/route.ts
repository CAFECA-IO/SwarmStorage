import { NextRequest } from 'next/server';
import { jsonOk } from '@/lib/response';
import { SESSION_COOKIE, sessionFromHeaders } from '@/lib/auth_session';
import { getCafecaConfig } from '@/lib/cafeca_login';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261108 - Luphia) 處理 GET /api/v1/auth/session
 * 目前登入狀態：{ enabled, wallet, user: { account, handle } | null }
 */
export async function GET(request: NextRequest) {
  const config = getCafecaConfig();
  const session = sessionFromHeaders(request.headers);
  return jsonOk(
    {
      enabled: !!config,
      wallet: config?.wallet ?? null,
      user: session ? { account: session.account, handle: session.handle } : null,
    },
    'OK',
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Info: (20261108 - Luphia) 處理 DELETE /api/v1/auth/session
 * 登出：清除 session cookie (回到這台瀏覽器的匿名身分)
 */
export async function DELETE() {
  const response = jsonOk(null, 'Signed out');
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
