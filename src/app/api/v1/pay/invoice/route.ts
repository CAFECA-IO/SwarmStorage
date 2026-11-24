import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { sessionFromHeaders } from '@/lib/auth_session';
import { openInvoice } from '@/lib/pay_rooms';
import { checkInvoice, getInvoice, publicInvoice } from '@/lib/pay_server';
import { PAY_CODES, originOf } from '@/lib/pay_http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Info: (20261120 - Luphia) POST /api/v1/pay/invoice
 * body: { roomId, kind: 'extend' | 'access', planId?, token?: 'USDC' } (只收 USDC)
 * 開一張帳單 (延長房間付給平台；付費進房 90% 給房主、10% 給平台)
 */
export async function POST(request: NextRequest) {
  let body: { roomId?: unknown; kind?: unknown; planId?: unknown; token?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId : '';
  const memberHash = memberHashFromRequest(request.headers);
  const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
  if (!access.ok) return jsonFail(access.code, access.message);
  const session = sessionFromHeaders(request.headers);
  try {
    const result = await openInvoice(roomId, access.roomPath, access.config, { memberHash, name: session?.handle ? `@${session.handle}` : null }, body);
    if (!result.ok) return jsonFail(PAY_CODES[result.status], result.message);
    return jsonOk({ invoice: publicInvoice(result.data, originOf(request)) });
  } catch (err) {
    console.error('[Pay] invoice failed:', err);
    return jsonFail(ApiCode.SERVER_ERROR, 'The payment request could not be created');
  }
}

/**
 * Info: (20261120 - Luphia) GET /api/v1/pay/invoice?id=
 * 帳單狀態 (同時在鏈上找付款，最多每 2 秒一次)
 */
export async function GET(request: NextRequest) {
  const invoice = await getInvoice(request.nextUrl.searchParams.get('id'));
  if (!invoice) return jsonFail(ApiCode.NOT_FOUND, 'Payment request not found');
  await checkInvoice(invoice);
  return jsonOk({ invoice: publicInvoice(invoice, originOf(request)) }, 'OK', { headers: { 'Cache-Control': 'no-store' } });
}
