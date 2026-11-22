import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { accountMemberHash, sessionFromHeaders } from '@/lib/auth_session';
import { EARNINGS_RANGES, earningsFor, type TEarningsRange } from '@/lib/owner_earnings';
import { formatAmount } from '@/lib/pay_plans';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * Info: (20261122 - Luphia) GET /api/v1/me/earnings?range=30d|90d|all (CAFECA 登入)
 * 自己所有房間的付費進房收入；&format=csv 下載期間內的銷售紀錄
 */
export async function GET(request: NextRequest) {
  const session = sessionFromHeaders(request.headers);
  if (!session) return jsonFail(ApiCode.UNAUTHORIZED, 'Sign in with CAFECA to see your earnings');
  const asked = request.nextUrl.searchParams.get('range') as TEarningsRange | null;
  const range: TEarningsRange = asked && EARNINGS_RANGES.includes(asked) ? asked : '30d';
  const earnings = await earningsFor(accountMemberHash(session.account), range);

  if (request.nextUrl.searchParams.get('format') === 'csv') {
    const rows = [['time', 'room', 'room_name', 'buyer', 'token', 'paid', 'you_received', 'drophere_fee', 'transaction']];
    earnings.sales.forEach(s => rows.push([new Date(s.at).toISOString(), s.roomId, s.roomName, s.buyerName ?? '', s.token, formatAmount(s.amount), formatAmount(s.owner), formatAmount(s.fee), s.signature]));
    return new Response(rows.map(r => r.map(csvCell).join(',')).join('\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="drophere-earnings-${range}.csv"`, 'Cache-Control': 'no-store' },
    });
  }
  return jsonOk(earnings, 'OK', { headers: { 'Cache-Control': 'no-store' } });
}
