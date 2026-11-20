import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import '@/lib/pay_rooms';
import { PayError, checkInvoice, getInvoice, submitTransaction } from '@/lib/pay_server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Info: (20261120 - Luphia) POST /api/v1/pay/submit  body: { invoice, transaction (base64) }
 * 錢包只簽章不送出時，由伺服器把簽好的交易送上鏈
 */
export async function POST(request: NextRequest) {
  let body: { invoice?: unknown; transaction?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const invoice = await getInvoice(body.invoice);
  if (!invoice) return jsonFail(ApiCode.NOT_FOUND, 'Payment request not found');
  if (typeof body.transaction !== 'string' || body.transaction.length > 4000) return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid transaction');
  try {
    const signature = await submitTransaction(invoice, body.transaction);
    checkInvoice(invoice, true).catch(() => undefined);
    return jsonOk({ signature });
  } catch (err) {
    if (!(err instanceof PayError)) console.error('[Pay] submit failed:', err);
    return jsonFail(ApiCode.VALIDATION_ERROR, err instanceof PayError ? err.message : 'The payment could not be sent');
  }
}
