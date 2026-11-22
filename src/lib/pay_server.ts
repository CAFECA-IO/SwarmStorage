import { promises as fs } from 'fs';
import path from 'path';
import { createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'crypto';
import { Connection, Keypair, PublicKey, Transaction, type ParsedTransactionWithMeta, type TokenBalance } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DROPHERE_DATA_DIR } from '@/lib/server_env';
import { INVOICE_TTL_MS, TOKEN_DECIMALS, formatAmount, type IPublicInvoice, type TInvoiceKind, type TPayToken } from '@/lib/pay_plans';

/**
 * Info: (20261120 - Luphia)
 * Solana 收款 (伺服器端)：帳單、組交易 (平台代付手續費)、以 reference 在鏈上找付款並驗證
 * - 帳單存於 DROPHERE_DATA_DIR/payments (需持久化)；每筆交易簽章只能使用一次
 * - 設定：SOLANA_RPC_URL、PAY_TREASURY (平台收款地址)、PAY_FEE_PAYER_SECRET (代付手續費的錢包私鑰)
 *   測試或 devnet 可用 PAY_USDC_MINT / PAY_USDT_MINT 覆寫幣種地址
 */

const MAINNET_MINTS: Record<TPayToken, string> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};
const RPC_URL = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const PAY_DIR = path.join(DROPHERE_DATA_DIR, 'payments');
// Info: (20261122 - Luphia) 查鏈頻率：剛付款 (30 秒內) 或已看到交易時每 2 秒；5 分鐘內每 5 秒；之後每 10 秒；帳單過期後每 30 秒
const FAST_CHECK_MS = 2000;
const FAST_WINDOW_MS = 30 * 1000;
const MEDIUM_CHECK_MS = 5000;
const MEDIUM_WINDOW_MS = 5 * 60 * 1000;
const SLOW_CHECK_MS = 10 * 1000;
const EXPIRED_CHECK_MS = 30 * 1000;
// Info: (20261122 - Luphia) 同時進行的查鏈最多 4 筆 (避免瞬間用光 RPC 額度)
const MAX_PARALLEL_CHECKS = 4;
// Info: (20261122 - Luphia) 被 RPC 限流 (429) 時暫停查鏈：2 秒起、每次加倍、最多 30 秒
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 30 * 1000;
// Info: (20261120 - Luphia) 帳單過期後仍持續在鏈上找 24 小時 (轉帳 QR 可能晚到)
const WATCH_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 1000;

export class PayError extends Error {}

export const mintOf = (token: TPayToken) => new PublicKey(process.env[`PAY_${token}_MINT`]?.trim() || MAINNET_MINTS[token]);

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodeBase58(text: string): Uint8Array {
  let value = BigInt(0);
  for (const char of text) {
    const index = BASE58.indexOf(char);
    if (index < 0) throw new Error('Invalid base58');
    value = value * BigInt(58) + BigInt(index);
  }
  const bytes: number[] = [];
  while (value > BigInt(0)) {
    bytes.unshift(Number(value % BigInt(256)));
    value /= BigInt(256);
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

interface IPayConfig {
  treasury: PublicKey;
  feePayer: Keypair;
}

let cachedConfig: IPayConfig | null | undefined;
// Info: (20261120 - Luphia) 沒有設定平台收款地址或代付錢包時，付款功能關閉
export function payConfig(): IPayConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    const treasury = process.env.PAY_TREASURY?.trim();
    const secret = process.env.PAY_FEE_PAYER_SECRET?.trim();
    if (!treasury || !secret) {
      cachedConfig = null;
      return null;
    }
    const bytes = secret.startsWith('[') ? Uint8Array.from(JSON.parse(secret) as number[]) : decodeBase58(secret);
    cachedConfig = { treasury: new PublicKey(treasury), feePayer: Keypair.fromSecretKey(bytes) };
  } catch (err) {
    console.error('[Pay] Invalid PAY_TREASURY or PAY_FEE_PAYER_SECRET:', err instanceof Error ? err.message : err);
    cachedConfig = null;
  }
  return cachedConfig;
}

let connection: Connection | null = null;
// Info: (20261122 - Luphia) 不使用 web3.js 內建的限流重試 (會卡住請求)，改由這裡統一退避
const rpc = () => (connection ??= new Connection(RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true }));

const isRateLimited = (err: unknown) => /429|too many requests|rate limit/i.test(err instanceof Error ? err.message : String(err));

export const isValidAddress = (address: unknown): address is string => {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  try {
    return new PublicKey(address).toBase58() === address;
  } catch {
    return false;
  }
};

// --- Info: (20261120 - Luphia) 帳單 ---

export interface IInvoice extends Omit<IPublicInvoice, 'payUrl'> {
  reference: string;
  mint: string;
  memberHash: string | null;
  buyerName: string | null;
  // Info: (20261120 - Luphia) 延長方案 (天數、容量) 或付費房名稱
  days: number | null;
  gb: number | null;
  title: string;
  lastCheckAt: number;
  confirming: boolean;
  // Info: (20261122 - Luphia) 買家最近一次動作 (取得交易、送出交易)：之後 30 秒內加快查鏈
  activeAt?: number;
}

interface IPayState {
  invoices: Map<string, IInvoice>;
  loaded: boolean;
  sweeper?: ReturnType<typeof setInterval>;
  checking: Set<string>;
  onPaid: ((invoice: IInvoice) => Promise<IInvoice['result']>) | null;
  backoffUntil: number;
  backoffMs: number;
}
const globalForPay = globalThis as unknown as { drophereePay?: IPayState };
const state: IPayState = globalForPay.drophereePay ?? { invoices: new Map(), loaded: false, checking: new Set(), onPaid: null, backoffUntil: 0, backoffMs: 0 };
state.backoffUntil ??= 0;
state.backoffMs ??= 0;

function noteRateLimit() {
  state.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, state.backoffMs * 2));
  state.backoffUntil = Date.now() + state.backoffMs;
  console.warn(`[Pay] RPC rate limited; pausing chain checks for ${state.backoffMs / 1000} s`);
}

const RPC_BUSY = 'The payment network is busy. Try again in a few seconds.';
globalForPay.drophereePay = state;

const invoiceFile = (id: string) => path.join(PAY_DIR, 'invoices', `${id}.json`);

async function saveInvoice(invoice: IInvoice) {
  await fs.mkdir(path.dirname(invoiceFile(invoice.id)), { recursive: true });
  const tmp = `${invoiceFile(invoice.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(invoice, null, 2));
  await fs.rename(tmp, invoiceFile(invoice.id));
}

// Info: (20261120 - Luphia) 啟動後載入 24 小時內仍未付款的帳單 (繼續在鏈上找)
async function loadPending() {
  if (state.loaded) return;
  state.loaded = true;
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(PAY_DIR, 'invoices'));
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const invoice = JSON.parse(await fs.readFile(path.join(PAY_DIR, 'invoices', name), 'utf-8')) as IInvoice;
      if (invoice.status === 'pending' && now - invoice.createdAt < WATCH_MS) state.invoices.set(invoice.id, invoice);
    } catch {
      // Info: (20261120 - Luphia) ignore
    }
  }
}

export async function getInvoice(id: unknown): Promise<IInvoice | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
  await loadPending();
  const cached = state.invoices.get(id);
  if (cached) return cached;
  try {
    return JSON.parse(await fs.readFile(invoiceFile(id), 'utf-8')) as IInvoice;
  } catch {
    return null;
  }
}

export const publicInvoice = (invoice: IInvoice, origin: string): IPublicInvoice & { confirming: boolean; title: string } => ({
  id: invoice.id,
  kind: invoice.kind,
  roomId: invoice.roomId,
  token: invoice.token,
  amount: invoice.amount,
  payees: invoice.payees,
  planId: invoice.planId,
  status: invoice.status === 'pending' && Date.now() > invoice.expiresAt ? 'expired' : invoice.status,
  createdAt: invoice.createdAt,
  expiresAt: invoice.expiresAt,
  payUrl: `solana:${encodeURIComponent(`${origin}/api/v1/pay/tx?invoice=${invoice.id}`)}`,
  signature: invoice.signature,
  paidAt: invoice.paidAt,
  payer: invoice.payer,
  result: invoice.result,
  confirming: invoice.confirming,
  title: invoice.title,
});

export async function createInvoice(input: {
  kind: TInvoiceKind;
  roomId: string;
  token: TPayToken;
  payees: IInvoice['payees'];
  planId: string | null;
  days: number | null;
  gb: number | null;
  title: string;
  memberHash: string | null;
  buyerName: string | null;
}): Promise<IInvoice> {
  await loadPending();
  const now = Date.now();
  const invoice: IInvoice = {
    ...input,
    id: randomUUID(),
    amount: input.payees.reduce((sum, p) => sum + p.amount, 0),
    reference: Keypair.generate().publicKey.toBase58(),
    mint: mintOf(input.token).toBase58(),
    status: 'pending',
    createdAt: now,
    expiresAt: now + INVOICE_TTL_MS,
    signature: null,
    paidAt: null,
    payer: null,
    result: null,
    lastCheckAt: 0,
    confirming: false,
  };
  await saveInvoice(invoice);
  state.invoices.set(invoice.id, invoice);
  startSweeper();
  return invoice;
}

// Info: (20261120 - Luphia) 同一成員短時間內開太多帳單時拒絕
export function pendingCountFor(memberHash: string | null): number {
  const since = Date.now() - 60 * 60 * 1000;
  return [...state.invoices.values()].filter(i => i.memberHash === memberHash && i.createdAt > since && i.status === 'pending').length;
}

// --- Info: (20261120 - Luphia) 組交易 (Solana Pay 交易請求) ---

/**
 * Info: (20261120 - Luphia)
 * 買家 account 付款的交易：替收款人建立代幣帳戶 (需要時)、transferChecked 給每位收款人、帶上 reference
 * 平台為 fee payer 並先簽章；買家錢包簽章後送出 (或交給伺服器送出)
 */
export async function buildPaymentTransaction(invoice: IInvoice, account: string): Promise<{ transaction: string; message: string }> {
  const config = payConfig();
  if (!config) throw new PayError('Payments are not available on this server');
  if (invoice.status !== 'pending' || Date.now() > invoice.expiresAt) throw new PayError('This payment request has expired. Start again.');
  if (!isValidAddress(account)) throw new PayError('Invalid wallet address');
  const payer = new PublicKey(account);
  if (payer.equals(config.feePayer.publicKey)) throw new PayError('Invalid wallet address');
  const mint = new PublicKey(invoice.mint);
  const source = getAssociatedTokenAddressSync(mint, payer, true);
  invoice.activeAt = Date.now();

  // Info: (20261120 - Luphia) 餘額不足時直接告訴使用者 (查不到時略過，交給錢包模擬)
  try {
    const balance = await rpc().getTokenAccountBalance(source);
    if (BigInt(balance.value.amount) < BigInt(invoice.amount)) {
      throw new PayError(`This wallet has ${balance.value.uiAmountString ?? '0'} ${invoice.token}; ${formatAmount(invoice.amount)} is needed`);
    }
  } catch (err) {
    if (err instanceof PayError) throw err;
    const text = err instanceof Error ? err.message : '';
    if (/could not find account|Invalid param: could not find/i.test(text)) throw new PayError(`This wallet has no ${invoice.token} on Solana`);
  }

  let blockhash: string;
  try {
    ({ blockhash } = await rpc().getLatestBlockhash('confirmed'));
  } catch (err) {
    if (isRateLimited(err)) {
      noteRateLimit();
      throw new PayError(RPC_BUSY);
    }
    throw err;
  }
  const tx = new Transaction({ feePayer: config.feePayer.publicKey, recentBlockhash: blockhash });
  const reference = new PublicKey(invoice.reference);
  invoice.payees.forEach((payee, index) => {
    const owner = new PublicKey(payee.address);
    const destination = getAssociatedTokenAddressSync(mint, owner, true);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(config.feePayer.publicKey, destination, owner, mint));
    const transfer = createTransferCheckedInstruction(source, mint, destination, payer, BigInt(payee.amount), TOKEN_DECIMALS);
    if (index === 0) transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
    tx.add(transfer);
  });
  tx.partialSign(config.feePayer);
  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    message: `${invoice.title} · ${formatAmount(invoice.amount)} ${invoice.token}`,
  };
}

// Info: (20261120 - Luphia) 轉送買家錢包簽好的交易 (錢包只提供簽章、不送出時)
export async function submitTransaction(invoice: IInvoice, base64: string): Promise<string> {
  if (invoice.status !== 'pending') throw new PayError('This payment request is no longer open');
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(base64, 'base64'));
  } catch {
    throw new PayError('Invalid transaction');
  }
  const config = payConfig();
  if (!config || !tx.feePayer?.equals(config.feePayer.publicKey)) throw new PayError('Invalid transaction');
  if (!tx.instructions.some(ix => ix.keys.some(k => k.pubkey.toBase58() === invoice.reference))) throw new PayError('This transaction is for another payment');
  try {
    const signature = await rpc().sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
    invoice.lastCheckAt = 0;
    invoice.activeAt = Date.now();
    return signature;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.warn('[Pay] submit failed:', text);
    if (isRateLimited(err)) {
      noteRateLimit();
      throw new PayError(RPC_BUSY);
    }
    if (/insufficient funds/i.test(text)) throw new PayError(`Not enough ${invoice.token} in this wallet`);
    if (/blockhash not found|expired/i.test(text)) throw new PayError('The transaction took too long to sign. Try again.');
    throw new PayError('The payment could not be sent. Try again.');
  }
}

// --- Info: (20261120 - Luphia) 驗證 ---

const balanceOf = (balances: TokenBalance[] | null | undefined, owner: string, mint: string) =>
  (balances ?? []).filter(b => b.owner === owner && b.mint === mint).reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), BigInt(0));

// Info: (20261120 - Luphia) 交易成功、包含 reference，且每位收款人都收到足額的該幣種
function matches(invoice: IInvoice, tx: ParsedTransactionWithMeta): string | null {
  if (!tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
  if (!keys.includes(invoice.reference)) return null;
  for (const payee of invoice.payees) {
    const delta = balanceOf(tx.meta.postTokenBalances, payee.address, invoice.mint) - balanceOf(tx.meta.preTokenBalances, payee.address, invoice.mint);
    if (delta < BigInt(payee.amount)) return null;
  }
  // Info: (20261120 - Luphia) 付款人：轉出代幣的帳戶持有人 (排除收款人)
  const payees = new Set(invoice.payees.map(p => p.address));
  const payer = (tx.meta.preTokenBalances ?? []).find(b => b.mint === invoice.mint && b.owner && !payees.has(b.owner))?.owner;
  return payer ?? keys[1] ?? keys[0];
}

async function claimSignature(signature: string): Promise<boolean> {
  const file = path.join(PAY_DIR, 'signatures', `${signature}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, JSON.stringify({ at: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function onInvoicePaid(handler: (invoice: IInvoice) => Promise<IInvoice['result']>) {
  state.onPaid = handler;
}

/**
 * Info: (20261120 - Luphia)
 * 在鏈上找這張帳單的付款 (頻率見 checkIntervalOf；被限流時暫停)：找到已確認的交易 → confirming；最終確認 (finalized) 且金額正確 → 套用
 * 瀏覽器每 2 秒詢問一次，但只有到了查鏈時間才真的呼叫 RPC，其餘回傳目前狀態
 */
function checkIntervalOf(invoice: IInvoice, now: number): number {
  if (invoice.confirming) return FAST_CHECK_MS;
  if (now > invoice.expiresAt) return EXPIRED_CHECK_MS;
  const since = now - Math.max(invoice.createdAt, invoice.activeAt ?? 0);
  if (since < FAST_WINDOW_MS) return FAST_CHECK_MS;
  if (since < MEDIUM_WINDOW_MS) return MEDIUM_CHECK_MS;
  return SLOW_CHECK_MS;
}

export async function checkInvoice(invoice: IInvoice, force = false): Promise<IInvoice> {
  if (invoice.status !== 'pending' || state.checking.has(invoice.id)) return invoice;
  const now = Date.now();
  if (now < state.backoffUntil) return invoice;
  if (!force && (now - invoice.lastCheckAt < checkIntervalOf(invoice, now) || state.checking.size >= MAX_PARALLEL_CHECKS)) return invoice;
  state.checking.add(invoice.id);
  invoice.lastCheckAt = Date.now();
  try {
    const found = await rpc().getSignaturesForAddress(new PublicKey(invoice.reference), { limit: 10 }, 'confirmed');
    const candidates = found.filter(s => !s.err);
    invoice.confirming = candidates.length > 0;
    for (const candidate of candidates) {
      const tx = await rpc().getParsedTransaction(candidate.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const payer = matches(invoice, tx);
      if (!payer || !(await claimSignature(candidate.signature))) continue;
      invoice.status = 'paid';
      invoice.signature = candidate.signature;
      invoice.payer = payer;
      invoice.paidAt = Date.now();
      invoice.confirming = false;
      await saveInvoice(invoice);
      try {
        invoice.result = (await state.onPaid?.(invoice)) ?? null;
      } catch (err) {
        console.error('[Pay] applying a paid invoice failed:', invoice.id, err);
      }
      await saveInvoice(invoice);
      state.invoices.delete(invoice.id);
      break;
    }
    state.backoffMs = 0;
  } catch (err) {
    if (isRateLimited(err)) noteRateLimit();
    else console.warn('[Pay] check failed:', err instanceof Error ? err.message : err);
  } finally {
    state.checking.delete(invoice.id);
  }
  return invoice;
}

function startSweeper() {
  if (state.sweeper) return;
  state.sweeper = setInterval(() => {
    const now = Date.now();
    state.invoices.forEach(invoice => {
      if (now - invoice.createdAt > WATCH_MS) {
        state.invoices.delete(invoice.id);
        return;
      }
      // Info: (20261122 - Luphia) 依各帳單的查鏈頻率 (checkInvoice 內判斷)；分散在這一輪內，避免同時送出
      checkInvoice(invoice).catch(() => undefined);
    });
  }, SWEEP_MS);
  state.sweeper.unref?.();
}

export async function ensureWatching() {
  await loadPending();
  if (state.invoices.size) startSweeper();
}

// --- Info: (20261120 - Luphia) 錢包簽章 (證明收款地址、恢復權限) ---

const challenges = new Map<string, { message: string; expiresAt: number }>();

export function issueChallenge(key: string, purpose: string): string {
  const now = Date.now();
  challenges.forEach((c, k) => c.expiresAt < now && challenges.delete(k));
  const message = `${purpose}\nNonce: ${randomBytes(12).toString('hex')}\nIssued: ${new Date(now).toISOString()}`;
  challenges.set(key, { message, expiresAt: now + 10 * 60 * 1000 });
  return message;
}

// Info: (20261120 - Luphia) 驗證錢包對挑戰訊息的 ed25519 簽章 (挑戰只能用一次)
export function verifyChallenge(key: string, address: unknown, signatureBase64: unknown): boolean {
  const challenge = challenges.get(key);
  challenges.delete(key);
  if (!challenge || challenge.expiresAt < Date.now() || !isValidAddress(address) || typeof signatureBase64 !== 'string') return false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(new PublicKey(address).toBytes()).toString('base64url') }, format: 'jwk' });
    const signature = Buffer.from(signatureBase64, 'base64');
    return signature.length === 64 && verifySignature(null, Buffer.from(challenge.message, 'utf-8'), publicKey, signature);
  } catch {
    return false;
  }
}
