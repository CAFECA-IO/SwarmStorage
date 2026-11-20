import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest, type IRoomConfig } from '@/lib/room_access';
import { sessionFromHeaders } from '@/lib/auth_session';
import { listRoomFiles } from '@/lib/room_store';
import { broadcastRoomEvent } from '@/lib/chat_hub';
import { readSales, updatePaidConfig } from '@/lib/room_paid';
import { issueChallenge, isValidAddress, verifyChallenge } from '@/lib/pay_server';
import { DAY_MS, MAX_ACCESS_PRICE, MIN_ACCESS_PRICE, PAID_MIN_DAYS, formatAmount } from '@/lib/pay_plans';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Info: (20261120 - Luphia) 付費房賣家需要的 CAFECA 實名等級
const SELLER_KYC = Math.max(0, Number(process.env.PAY_SELLER_KYC ?? 2));

const challengeKey = (roomId: string, memberHash: string) => `payout:${roomId}:${memberHash}`;

async function ownerAccess(request: NextRequest, roomId: string) {
  const memberHash = memberHashFromRequest(request.headers);
  const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
  if (!access.ok) return { error: jsonFail(access.code, access.message) } as const;
  if (!access.isOwner || !memberHash) return { error: jsonFail(ApiCode.FORBIDDEN, 'Only the room owner can change paid access') } as const;
  return { access, memberHash } as const;
}

const sellerView = (config: IRoomConfig) => ({
  enabled: !!config.paid?.enabled,
  price: config.paid?.price ?? 5_000_000,
  payout: config.paid?.payout ?? null,
  payoutVerifiedAt: config.paid?.payoutVerifiedAt ?? null,
  previewNames: config.paid?.previewNames ?? true,
  previewFiles: config.paid?.previewFiles ?? [],
  lastSaleAt: config.paid?.lastSaleAt ?? null,
});

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * Info: (20261120 - Luphia) GET /api/v1/room/[room_id]/paid (房主)
 * 付費設定、賣家條件 (CAFECA 實名)、銷售紀錄；?format=csv 下載銷售紀錄
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  const owner = await ownerAccess(request, roomId);
  if ('error' in owner) return owner.error;
  const sales = await readSales(owner.access.roomPath);
  if (request.nextUrl.searchParams.get('format') === 'csv') {
    const rows = [['time', 'buyer', 'payer', 'token', 'paid', 'you_received', 'drophere_fee', 'transaction']];
    sales.forEach(s => rows.push([new Date(s.at).toISOString(), s.buyerName ?? '', s.payer, s.token, formatAmount(s.amount), formatAmount(s.owner), formatAmount(s.fee), s.signature]));
    return new Response(rows.map(r => r.map(csvCell).join(',')).join('\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="room-${roomId}-sales.csv"`, 'Cache-Control': 'no-store' },
    });
  }
  const session = sessionFromHeaders(request.headers);
  return jsonOk({
    paid: sellerView(owner.access.config),
    seller: { signedIn: !!session, handle: session?.handle ?? null, kyc: session?.kyc ?? null, required: SELLER_KYC },
    sales: sales.slice(-200).reverse(),
    totals: { count: sales.length, received: sales.reduce((sum, s) => sum + s.owner, 0) },
  }, 'OK', { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Info: (20261120 - Luphia) POST /api/v1/room/[room_id]/paid (房主)
 * - { action: 'challenge' }：取得要讓收款錢包簽署的訊息
 * - { action: 'payout', address, signature }：以簽章證明收款地址
 * - { action: 'update', enabled?, price?, previewNames?, previewFiles? }
 * 開啟付費需要：CAFECA 登入且實名等級足夠、已證明的收款地址、房間至少還有 30 天；開啟後只有房主可以上傳
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  const owner = await ownerAccess(request, roomId);
  if ('error' in owner) return owner.error;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const session = sessionFromHeaders(request.headers);
  const key = challengeKey(roomId, owner.memberHash);

  if (body.action === 'challenge') {
    return jsonOk({ message: issueChallenge(key, `Drop Here: receive payments for room ${roomId} at this address`) });
  }

  if (body.action === 'payout') {
    if (!isValidAddress(body.address) || !verifyChallenge(key, body.address, body.signature)) {
      return jsonFail(ApiCode.UNAUTHORIZED, 'The signature could not be verified. Try again.');
    }
    const address = body.address as string;
    const result = await updatePaidConfig(roomId, config => ({
      ...config,
      paid: { ...sellerViewToConfig(config), payout: address, payoutVerifiedAt: Date.now() },
    }));
    if ('error' in result) return jsonFail(ApiCode.VALIDATION_ERROR, result.error);
    return jsonOk({ paid: sellerView(result) });
  }

  if (body.action === 'update') {
    const files = new Set((await listRoomFiles(owner.access.roomPath)).map(f => f.filename));
    const result = await updatePaidConfig(roomId, config => {
      const current = sellerViewToConfig(config);
      const next = { ...current };
      if ('price' in body) {
        const price = Number(body.price);
        if (!Number.isInteger(price) || price < MIN_ACCESS_PRICE || price > MAX_ACCESS_PRICE) return { error: `Choose a price between ${formatAmount(MIN_ACCESS_PRICE)} and ${formatAmount(MAX_ACCESS_PRICE)}` };
        next.price = price;
      }
      if ('previewNames' in body) next.previewNames = body.previewNames !== false;
      if ('previewFiles' in body) {
        if (!Array.isArray(body.previewFiles) || body.previewFiles.length > 50) return { error: 'Invalid preview files' };
        next.previewFiles = body.previewFiles.filter((f): f is string => typeof f === 'string' && files.has(f));
      }
      let uploadPolicy = config.uploadPolicy;
      if ('enabled' in body) {
        const enable = body.enabled === true;
        if (enable && !current.enabled) {
          if (!session) return { error: 'Sign in with CAFECA to sell access to a room' };
          if ((session.kyc ?? -1) < SELLER_KYC) return { error: 'Your CAFECA account needs ID verification to sell access. Verify in CAFECA, then sign in again.' };
          if (!next.payout || !next.payoutVerifiedAt) return { error: 'Add the Solana address that receives your payments first' };
          if ((config.expiration?.expiresAt ?? Infinity) < Date.now() + PAID_MIN_DAYS * DAY_MS) return { error: `A paid room must stay open at least ${PAID_MIN_DAYS} days. Extend the room first.` };
          next.ownerName = session.handle ? `@${session.handle}` : null;
          // Info: (20261120 - Luphia) 付費房的內容由房主負責：只有房主可以上傳
          uploadPolicy = 'owner';
        }
        next.enabled = enable;
      }
      return { ...config, uploadPolicy, paid: next };
    });
    if ('error' in result) return jsonFail(ApiCode.VALIDATION_ERROR, result.error);
    broadcastRoomEvent(roomId, { type: 'pay', change: 'paid-settings' });
    return jsonOk({ paid: sellerView(result) });
  }
  return jsonFail(ApiCode.VALIDATION_ERROR, 'Unknown action');
}

function sellerViewToConfig(config: IRoomConfig) {
  return {
    enabled: !!config.paid?.enabled,
    price: config.paid?.price ?? 5_000_000,
    payout: config.paid?.payout ?? null,
    payoutVerifiedAt: config.paid?.payoutVerifiedAt ?? null,
    ownerName: config.paid?.ownerName ?? null,
    previewNames: config.paid?.previewNames ?? true,
    previewFiles: config.paid?.previewFiles ?? [],
    lastSaleAt: config.paid?.lastSaleAt ?? null,
  };
}
