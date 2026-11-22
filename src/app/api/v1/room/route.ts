import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { memberHashFromRequest } from '@/lib/room_access';
import { createRoom, listRooms } from '@/lib/room_store';
import { sessionFromHeaders } from '@/lib/auth_session';
import { payConfig } from '@/lib/pay_server';
import { SELLER_KYC } from '@/lib/room_paid';
import { MAX_ACCESS_PRICE, MIN_ACCESS_PRICE, formatAmount } from '@/lib/pay_plans';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 GET /api/v1/room
 * 房間清單：公開的房間、自己建立的房間 (x-member-key)、以及 include=房號,房號 (最近造訪)
 */
export async function GET(request: NextRequest) {
  try {
    const include = (request.nextUrl.searchParams.get('include') || '').split(',').slice(0, 50);
    const rooms = await listRooms(memberHashFromRequest(request.headers), include);
    return jsonOk({ rooms, serverTime: Date.now() }, 'OK', { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[Room] Error listing rooms:', error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}

/**
 * Info: (20261106 - Luphia) 處理 POST /api/v1/room
 * 建立房間 (需要 x-member-key，建立者即為房主)
 * body: { name, listed, uploadPolicy: 'owner' | 'everyone', allowDownload, password?, minutes }
 */
export async function POST(request: NextRequest) {
  try {
    const ownerHash = memberHashFromRequest(request.headers);
    if (!ownerHash) return jsonFail(ApiCode.UNAUTHORIZED, 'Missing member key');

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) ?? {};
    } catch {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
    }

    // Info: (20261122 - Luphia) 建立時選擇收費：需要付款功能、CAFECA 登入且實名等級足夠
    let paidPrice: number | null = null;
    if (body.paid && typeof body.paid === 'object') {
      const price = Number((body.paid as { price?: unknown }).price);
      if (!payConfig()) return jsonFail(ApiCode.VALIDATION_ERROR, 'Payments are not available on this server');
      if (!Number.isInteger(price) || price < MIN_ACCESS_PRICE || price > MAX_ACCESS_PRICE) {
        return jsonFail(ApiCode.VALIDATION_ERROR, `Choose a price between ${formatAmount(MIN_ACCESS_PRICE)} and ${formatAmount(MAX_ACCESS_PRICE)}`);
      }
      const session = sessionFromHeaders(request.headers);
      if (!session) return jsonFail(ApiCode.UNAUTHORIZED, 'Sign in with CAFECA to charge for access');
      if ((session.kyc ?? -1) < SELLER_KYC) return jsonFail(ApiCode.FORBIDDEN, 'Your CAFECA account needs ID verification to charge for access');
      paidPrice = price;
    }

    const result = await createRoom({
      name: body.name,
      listed: body.listed,
      uploadPolicy: body.uploadPolicy,
      allowDownload: body.allowDownload,
      password: body.password,
      minutes: body.minutes,
      ownerHash,
      paidPrice,
    });
    if ('error' in result) return jsonFail(ApiCode.VALIDATION_ERROR, result.error);
    console.log(`[Room] Created new room: ${result.roomNumber}`);
    return jsonOk(result, 'Room created successfully');
  } catch (error) {
    console.error('[Room] Error creating room:', error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
