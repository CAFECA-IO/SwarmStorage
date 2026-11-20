import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { issueChallenge, verifyChallenge } from '@/lib/pay_server';
import { restoreByWallet } from '@/lib/room_paid';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const keyOf = (roomId: string, memberHash: string) => `restore:${roomId}:${memberHash}`;

/**
 * Info: (20261120 - Luphia) GET /api/v1/pay/restore?roomId=：要讓付款錢包簽署的訊息
 */
export async function GET(request: NextRequest) {
  const roomId = request.nextUrl.searchParams.get('roomId') || '';
  const memberHash = memberHashFromRequest(request.headers);
  const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
  if (!access.ok) return jsonFail(access.code, access.message);
  if (!memberHash) return jsonFail(ApiCode.UNAUTHORIZED, 'Missing member key');
  return jsonOk({ message: issueChallenge(keyOf(roomId, memberHash), `Drop Here: restore my access to room ${roomId}`) });
}

/**
 * Info: (20261120 - Luphia) POST /api/v1/pay/restore  body: { roomId, address, signature (base64) }
 * 以付款錢包的簽章恢復權限 (換裝置或換瀏覽器)
 */
export async function POST(request: NextRequest) {
  let body: { roomId?: unknown; address?: unknown; signature?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId : '';
  const memberHash = memberHashFromRequest(request.headers);
  const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
  if (!access.ok) return jsonFail(access.code, access.message);
  if (!memberHash) return jsonFail(ApiCode.UNAUTHORIZED, 'Missing member key');
  if (!verifyChallenge(keyOf(roomId, memberHash), body.address, body.signature)) return jsonFail(ApiCode.UNAUTHORIZED, 'The signature could not be verified. Try again.');
  const restored = await restoreByWallet(roomId, body.address as string, memberHash);
  if (!restored) return jsonFail(ApiCode.NOT_FOUND, 'No purchase from this wallet for this room');
  return jsonOk({ restored: true });
}
