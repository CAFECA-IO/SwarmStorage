import { useCallback, useEffect, useRef, useState } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { ApiCode } from '@/lib/status';
import { memberHeaders } from '@/lib/member';
import { connectWallet, fromBase64, isUserRejection, signPayment, signText, toBase58, toBase64 } from '@/lib/solana_wallet';
import type { IPublicInvoice, TInvoiceKind, TPayToken } from '@/lib/pay_plans';

/**
 * Info: (20261120 - Luphia)
 * 付款 (瀏覽器端)：開帳單 → 錢包簽署 (平台代付手續費) → 每 2 秒查詢直到鏈上最終確認
 * 也可以用手機錢包掃 QR (Solana Pay 交易請求)，查詢方式相同
 */

export type TInvoiceView = IPublicInvoice & { confirming: boolean; title: string };
export type TPayPhase = 'idle' | 'creating' | 'waiting' | 'connecting' | 'signing' | 'sending' | 'confirming' | 'paid' | 'expired';

async function api<T>(url: string, init: RequestInit, password: string | null): Promise<T> {
  const res = await fetch(url, { ...init, headers: memberHeaders({ 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }, password) });
  const data = await res.json().catch(() => null);
  if (!data || data.code !== ApiCode.OK) throw new Error(data?.message || `Request failed (HTTP ${res.status})`);
  return data.payload as T;
}

export interface IPaymentRequest {
  kind: TInvoiceKind;
  planId?: string;
  token: TPayToken;
}

export function usePayment(roomId: string, password: string | null, onPaid: (invoice: TInvoiceView) => void) {
  const [invoice, setInvoice] = useState<TInvoiceView | null>(null);
  const [busy, setBusy] = useState<'creating' | 'connecting' | 'signing' | 'sending' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);
  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  });

  const start = useCallback(
    async (request: IPaymentRequest): Promise<TInvoiceView | null> => {
      setBusy('creating');
      setError(null);
      try {
        const { invoice: created } = await api<{ invoice: TInvoiceView }>('/api/v1/pay/invoice', { method: 'POST', body: JSON.stringify({ roomId, ...request }) }, password);
        setInvoice(created);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start the payment');
        setInvoice(null);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [password, roomId]
  );

  const reset = useCallback(() => {
    setInvoice(null);
    setError(null);
    setBusy(null);
  }, []);

  // Info: (20261120 - Luphia) 以瀏覽器錢包付款 (沒有帳單時先開帳單)
  const payWith = useCallback(
    async (wallet: Wallet, request: IPaymentRequest) => {
      setError(null);
      let current = invoice && invoice.status === 'pending' && Date.now() < invoice.expiresAt ? invoice : null;
      if (!current) current = await start(request);
      if (!current) return;
      try {
        setBusy('connecting');
        const acct = await connectWallet(wallet);
        setAccount({ wallet, account: acct });
        setBusy('signing');
        const res = await fetch(`/api/v1/pay/tx?invoice=${current.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct.address }) });
        const built = (await res.json()) as { transaction?: string; error?: string };
        if (!res.ok || !built.transaction) throw new Error(built.error || 'The payment could not be prepared');
        const result = await signPayment(wallet, acct, fromBase64(built.transaction));
        setBusy('sending');
        if ('signed' in result) {
          await api('/api/v1/pay/submit', { method: 'POST', body: JSON.stringify({ invoice: current.id, transaction: toBase64(result.signed) }) }, password);
        }
        setInvoice(prev => (prev ? { ...prev, confirming: true } : prev));
      } catch (err) {
        setError(isUserRejection(err) ? 'You cancelled in the wallet' : err instanceof Error ? err.message : 'The payment failed');
      } finally {
        setBusy(null);
      }
    },
    [invoice, password, start]
  );

  // Info: (20261120 - Luphia) 每 2 秒查詢帳單 (伺服器同時在鏈上找付款)
  const invoiceId = invoice?.id ?? null;
  const pending = invoice?.status === 'pending';
  useEffect(() => {
    if (!invoiceId || !pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { invoice: latest } = await api<{ invoice: TInvoiceView }>(`/api/v1/pay/invoice?id=${invoiceId}`, { method: 'GET' }, password);
        if (cancelled) return;
        setInvoice(prev => (prev && prev.id === latest.id ? { ...latest, confirming: latest.confirming || (prev.confirming && latest.status === 'pending') } : prev));
        if (latest.status === 'paid') {
          onPaidRef.current(latest);
          return;
        }
      } catch {
        // Info: (20261120 - Luphia) 暫時連不上：下次再查
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [invoiceId, pending, password]);

  const phase: TPayPhase = busy
    ? busy
    : !invoice
      ? 'idle'
      : invoice.status === 'paid'
        ? 'paid'
        : invoice.status === 'expired'
          ? 'expired'
          : invoice.confirming
            ? 'confirming'
            : 'waiting';

  return { invoice, phase, error, account, start, payWith, reset, setError };
}

// Info: (20261120 - Luphia) 以付款錢包恢復付費房權限
export async function restoreAccess(roomId: string, password: string | null, wallet: Wallet) {
  const account = await connectWallet(wallet);
  const { message } = await api<{ message: string }>(`/api/v1/pay/restore?roomId=${roomId}`, { method: 'GET' }, password);
  const signature = await signText(wallet, account, message);
  await api('/api/v1/pay/restore', { method: 'POST', body: JSON.stringify({ roomId, address: account.address, signature: toBase64(signature) }) }, password);
}

// --- Info: (20261120 - Luphia) 房主：付費進房設定 ---

export interface ISellerState {
  paid: { enabled: boolean; price: number; payout: string | null; payoutVerifiedAt: number | null; previewNames: boolean; previewFiles: string[]; lastSaleAt: number | null; setupPending: boolean };
  seller: { signedIn: boolean; handle: string | null; kyc: number | null; required: number };
  sales: { at: number; buyerName: string | null; payer: string; token: string; amount: number; owner: number; fee: number; signature: string }[];
  totals: { count: number; received: number };
}

export const fetchSeller = (roomId: string, password: string | null) => api<ISellerState>(`/api/v1/room/${roomId}/paid`, { method: 'GET' }, password);

export const updateSeller = (roomId: string, password: string | null, patch: Record<string, unknown>) =>
  api<{ paid: ISellerState['paid'] }>(`/api/v1/room/${roomId}/paid`, { method: 'POST', body: JSON.stringify({ action: 'update', ...patch }) }, password);

// Info: (20261120 - Luphia) 以錢包簽章證明收款地址
export async function verifyPayout(roomId: string, password: string | null, wallet: Wallet) {
  const account = await connectWallet(wallet);
  const { message } = await api<{ message: string }>(`/api/v1/room/${roomId}/paid`, { method: 'POST', body: JSON.stringify({ action: 'challenge' }) }, password);
  const signature = await signText(wallet, account, message);
  return api<{ paid: ISellerState['paid'] }>(
    `/api/v1/room/${roomId}/paid`,
    { method: 'POST', body: JSON.stringify({ action: 'payout', address: account.address, signature: toBase64(signature) }) },
    password
  );
}

export const explorerTx = (signature: string) => `https://solscan.io/tx/${signature}`;
export const signatureText = (bytes: Uint8Array) => toBase58(bytes);
