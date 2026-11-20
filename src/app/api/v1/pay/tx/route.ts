import { NextRequest, NextResponse } from 'next/server';
import '@/lib/pay_rooms';
import { PayError, buildPaymentTransaction, getInvoice } from '@/lib/pay_server';
import { originOf } from '@/lib/pay_http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Info: (20261120 - Luphia) Solana Pay 交易請求：錢包直接呼叫 (跨網域)，回應格式依規格 (不包 IApiResponse)
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Info: (20261120 - Luphia) GET /api/v1/pay/tx?invoice=：錢包顯示的名稱與圖示
 */
export function GET(request: NextRequest) {
  return NextResponse.json({ label: 'Drop Here', icon: `${originOf(request)}/favicon.svg` }, { headers: CORS });
}

/**
 * Info: (20261120 - Luphia) POST /api/v1/pay/tx?invoice=  body: { account }
 * 回傳平台已簽 (代付手續費) 的交易，買家錢包簽章後送出
 */
export async function POST(request: NextRequest) {
  const invoice = await getInvoice(request.nextUrl.searchParams.get('invoice'));
  if (!invoice) return NextResponse.json({ error: 'Payment request not found' }, { status: 404, headers: CORS });
  let account: unknown;
  try {
    account = ((await request.json()) as { account?: unknown }).account;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers: CORS });
  }
  try {
    const result = await buildPaymentTransaction(invoice, String(account ?? ''));
    return NextResponse.json(result, { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (!(err instanceof PayError)) console.error('[Pay] build failed:', err);
    return NextResponse.json({ error: err instanceof PayError ? err.message : 'The payment could not be prepared' }, { status: 400, headers: CORS });
  }
}
