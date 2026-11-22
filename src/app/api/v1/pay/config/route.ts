import { jsonOk } from '@/lib/response';
import { payConfig } from '@/lib/pay_server';
import { SELLER_KYC } from '@/lib/room_paid';
import { ACCESS_FEE_BPS, MAX_ACCESS_PRICE, MIN_ACCESS_PRICE, PAID_MIN_DAYS, ROOM_PLANS } from '@/lib/pay_plans';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Info: (20261122 - Luphia) GET /api/v1/pay/config
 * 付款功能是否開啟與公開的規則 (建立房間時顯示收費選項)
 */
export function GET() {
  return jsonOk(
    {
      enabled: !!payConfig(),
      plans: ROOM_PLANS,
      accessFeeBps: ACCESS_FEE_BPS,
      sellerKyc: SELLER_KYC,
      minPrice: MIN_ACCESS_PRICE,
      maxPrice: MAX_ACCESS_PRICE,
      paidMinDays: PAID_MIN_DAYS,
    },
    'OK',
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
