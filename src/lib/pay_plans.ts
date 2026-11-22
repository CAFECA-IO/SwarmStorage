/**
 * Info: (20261120 - Luphia)
 * 付款共用設定 (瀏覽器與伺服器共用)：Solana 上的 USDC / USDT，延長房間方案、付費房抽成
 * - 延長房間：付給平台；付費進房：同一筆交易 90% 給房主、10% 給平台
 * - Solana 網路手續費由平台代付 (平台為 fee payer)
 */

export type TPayToken = 'USDC' | 'USDT';
export const PAY_TOKENS: TPayToken[] = ['USDC', 'USDT'];
// Info: (20261120 - Luphia) 兩種穩定幣在 Solana 上都是 6 位小數
export const TOKEN_DECIMALS = 6;
export const MICRO = 1_000_000;

export interface IRoomPlan {
  id: string;
  days: number;
  gb: number;
  // Info: (20261120 - Luphia) 價格 (USD，以 micro 單位 = 0.000001 計)
  price: number;
}

export const ROOM_PLANS: IRoomPlan[] = [
  { id: '30d', days: 30, gb: 10, price: 3 * MICRO },
  { id: '90d', days: 90, gb: 50, price: 8 * MICRO },
  { id: '365d', days: 365, gb: 200, price: 25 * MICRO },
];

export const planById = (id: unknown) => ROOM_PLANS.find(p => p.id === id) ?? null;

// Info: (20261120 - Luphia) 付費房：平台抽成 10% (萬分比)
export const ACCESS_FEE_BPS = 1000;
// Info: (20261120 - Luphia) 付費房最後一筆銷售後至少保留 30 天 (到期時間不足 30 天時不能賣)
export const PAID_MIN_DAYS = 30;
// Info: (20261122 - Luphia) 付費房最低售價 5 USD
export const MIN_ACCESS_PRICE = 5 * MICRO;
export const MAX_ACCESS_PRICE = 10_000 * MICRO;
export const INVOICE_TTL_MS = 30 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const GB = 1024 * 1024 * 1024;

export const splitAccessPrice = (price: number) => {
  const fee = Math.round((price * ACCESS_FEE_BPS) / 10_000);
  return { owner: price - fee, fee };
};

// Info: (20261120 - Luphia) 金額顯示：5 → "5.00"；0.123456 → "0.123456"
export function formatAmount(micro: number): string {
  const value = micro / MICRO;
  const fixed = value.toFixed(6).replace(/0+$/, '');
  const [whole, frac = ''] = fixed.split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

export const parseAmount = (text: string): number | null => {
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(text.trim())) return null;
  return Math.round(Number(text.trim()) * MICRO);
};

export const shortAddress = (address: string) => (address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

export type TInvoiceKind = 'extend' | 'access';
export type TInvoiceStatus = 'pending' | 'paid' | 'expired';

// Info: (20261120 - Luphia) 給瀏覽器的帳單
export interface IPublicInvoice {
  id: string;
  kind: TInvoiceKind;
  roomId: string;
  token: TPayToken;
  amount: number;
  // Info: (20261120 - Luphia) 收款明細 (付費房：房主與平台)
  payees: { label: 'owner' | 'platform'; address: string; amount: number }[];
  planId: string | null;
  status: TInvoiceStatus;
  createdAt: number;
  expiresAt: number;
  // Info: (20261120 - Luphia) Solana Pay 交易請求 (手機錢包掃描)
  payUrl: string;
  signature: string | null;
  paidAt: number | null;
  payer: string | null;
  // Info: (20261120 - Luphia) 付款後的結果 (延長後的到期時間)
  result: { expiresAt?: number; capacityGb?: number } | null;
}

// Info: (20261120 - Luphia) 房間方案與付費設定 (房間設定 API 回傳)
export interface IRoomPayInfo {
  enabled: boolean;
  plan: { capacityBytes: number; until: number | null; paid: boolean };
  usedBytes: number;
  paid: {
    enabled: boolean;
    price: number;
    ownerName: string | null;
    ownerVerified: boolean;
    previewNames: boolean;
    previewFiles: string[];
    // Info: (20261120 - Luphia) 目前能否購買 (到期時間至少還有 30 天)
    onSale: boolean;
  } | null;
  // Info: (20261120 - Luphia) 自己是否能看完整內容
  access: 'full' | 'locked';
}
