import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { accountMemberHash, sessionFromHeaders } from '@/lib/auth_session';
import { markNoticesSeen, noticesFor } from '@/lib/owner_earnings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Info: (20261122 - Luphia) GET /api/v1/me/notifications?tz=<getTimezoneOffset>
 * 房主通知：新銷售、昨日摘要、付費房即將停賣；未登入時回傳 active: false
 */
export async function GET(request: NextRequest) {
  const session = sessionFromHeaders(request.headers);
  if (!session) return jsonOk({ active: false, seenAt: 0, unread: 0, received30: 0, notices: [] }, 'OK', { headers: { 'Cache-Control': 'no-store' } });
  const tz = Number(request.nextUrl.searchParams.get('tz'));
  const offset = Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? Math.round(tz) : 0;
  return jsonOk(await noticesFor(accountMemberHash(session.account), offset), 'OK', { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Info: (20261122 - Luphia) POST /api/v1/me/notifications { action: 'seen' }
 * 全部標為已讀 (換裝置也同步)
 */
export async function POST(request: NextRequest) {
  const session = sessionFromHeaders(request.headers);
  if (!session) return jsonFail(ApiCode.UNAUTHORIZED, 'Sign in with CAFECA first');
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  if (body.action !== 'seen') return jsonFail(ApiCode.VALIDATION_ERROR, 'Unknown action');
  const seenAt = await markNoticesSeen(accountMemberHash(session.account));
  return jsonOk({ seenAt });
}
