import path from 'path';
import { ROOM_BASE_DIR, isRoomOwner, readRoomConfig, type IRoomConfig } from '@/lib/room_access';
import { announceRoomSettings, broadcastRoomEvent, updateRoomTokenExpiry } from '@/lib/chat_hub';
import { publicSettings } from '@/lib/room_store';
import { applyExtension, applyPurchase, hasContentAccess, onSale } from '@/lib/room_paid';
import { createInvoice, ensureWatching, onInvoicePaid, payConfig, pendingCountFor, type IInvoice } from '@/lib/pay_server';
import { PAY_TOKENS, planById, splitAccessPrice, type TPayToken } from '@/lib/pay_plans';

/**
 * Info: (20261120 - Luphia)
 * 房間付款 (延長房間、付費進房)：開帳單前的檢查，與付款完成後的套用
 */

const MAX_PENDING_PER_MEMBER = 10;

export type TPayResult<T> = { ok: true; data: T } | { ok: false; status: 'invalid' | 'forbidden' | 'conflict' | 'unavailable'; message: string };

const fail = (status: 'invalid' | 'forbidden' | 'conflict' | 'unavailable', message: string) => ({ ok: false as const, status, message });

const roomName = (roomId: string, config: IRoomConfig) => config.name?.trim() || `Room ${roomId}`;

// Info: (20261120 - Luphia) 付款完成時由 pay_server 呼叫
onInvoicePaid(async (invoice: IInvoice) => {
  if (invoice.kind === 'extend' && invoice.days && invoice.gb) {
    const result = await applyExtension(invoice.roomId, invoice.days, invoice.gb);
    const config = await readRoomConfig(path.join(ROOM_BASE_DIR, invoice.roomId));
    updateRoomTokenExpiry(invoice.roomId, result.expiresAt);
    announceRoomSettings(invoice.roomId, publicSettings(invoice.roomId, config));
    broadcastRoomEvent(invoice.roomId, { type: 'pay', change: 'extended' });
    return result;
  }
  if (invoice.kind === 'access' && invoice.payer && invoice.signature) {
    const owner = invoice.payees.find(p => p.label === 'owner')?.amount ?? 0;
    const fee = invoice.payees.find(p => p.label === 'platform')?.amount ?? 0;
    await applyPurchase(
      invoice.roomId,
      { memberHash: invoice.memberHash, name: invoice.buyerName },
      { payer: invoice.payer, token: invoice.token, amount: invoice.amount, owner, fee, signature: invoice.signature }
    );
    broadcastRoomEvent(invoice.roomId, { type: 'pay', change: 'sale' });
    return {};
  }
  return null;
});

export async function openInvoice(
  roomId: string,
  roomPath: string,
  config: IRoomConfig,
  buyer: { memberHash: string | null; name: string | null },
  body: { kind?: unknown; planId?: unknown; token?: unknown }
): Promise<TPayResult<IInvoice>> {
  const pay = payConfig();
  if (!pay) return fail('unavailable', 'Payments are not available on this server');
  await ensureWatching();
  const token = PAY_TOKENS.includes(body.token as TPayToken) ? (body.token as TPayToken) : null;
  if (!token) return fail('invalid', 'Choose USDC or USDT');
  if (pendingCountFor(buyer.memberHash) >= MAX_PENDING_PER_MEMBER) return fail('conflict', 'Too many open payment requests; finish or wait for one to expire');
  const treasury = pay.treasury.toBase58();

  if (body.kind === 'extend') {
    const plan = planById(body.planId);
    if (!plan) return fail('invalid', 'Choose a plan');
    const invoice = await createInvoice({
      kind: 'extend',
      roomId,
      token,
      payees: [{ label: 'platform', address: treasury, amount: plan.price }],
      planId: plan.id,
      days: plan.days,
      gb: plan.gb,
      title: `Keep ${roomName(roomId, config)} ${plan.days} more days`,
      memberHash: buyer.memberHash,
      buyerName: buyer.name,
    });
    return { ok: true, data: invoice };
  }

  if (body.kind === 'access') {
    const paid = config.paid;
    if (!paid?.enabled || !paid.payout) return fail('invalid', 'This room is not for sale');
    if (!onSale(config)) return fail('conflict', 'Sales are paused: the room ends in less than 30 days. The owner needs to extend it first.');
    if (isRoomOwner(config, buyer.memberHash)) return fail('invalid', 'This is your room');
    if (await hasContentAccess(roomPath, config, buyer.memberHash)) return fail('conflict', 'You already have access to this room');
    const split = splitAccessPrice(paid.price);
    const invoice = await createInvoice({
      kind: 'access',
      roomId,
      token,
      payees: [
        { label: 'owner', address: paid.payout, amount: split.owner },
        { label: 'platform', address: treasury, amount: split.fee },
      ],
      planId: null,
      days: null,
      gb: null,
      title: `Unlock ${roomName(roomId, config)}`,
      memberHash: buyer.memberHash,
      buyerName: buyer.name,
    });
    return { ok: true, data: invoice };
  }
  return fail('invalid', 'Unknown payment');
}
