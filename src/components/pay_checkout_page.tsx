import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ILariaMetadata } from '@/lib/file_operator';
import type { IRoomSettings } from '@/lib/room_store';
import { listChildren } from '@/lib/folder_tree';
import { formatBytes } from '@/lib/utils';
import { useSolanaWallets, canSignMessage } from '@/lib/solana_wallet';
import { restoreAccess, usePayment } from '@/lib/pay_client';
import { formatAmount, splitAccessPrice, type TPayToken } from '@/lib/pay_plans';
import { PayStatus, PhoneQr, TokenToggle, TxLink, WalletButtons } from '@/components/pay_widgets';

/**
 * Info: (20261120 - Luphia)
 * 付費進房 B：可分享的結帳頁 (付費房沒買的人進房時看到)
 * 左：房間介紹、房主、內容清單 (檔名與大小，房主允許時) 與免費預覽檔
 * 右：選擇 → 付款 (瀏覽器錢包或手機掃碼，平台代付手續費) → 進房
 */

interface IPayCheckoutPageProps {
  roomId: string;
  password: string | null;
  settings: IRoomSettings;
  files: ILariaMetadata[];
  onDownloadFree: (filename: string) => void;
  onUnlocked: () => void;
}

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function PayCheckoutPage({ roomId, password, settings, files, onDownloadFree, onUnlocked }: IPayCheckoutPageProps) {
  const paid = settings.pay?.paid ?? null;
  const wallets = useSolanaWallets();
  const [token, setToken] = useState<TPayToken>('USDC');
  const [showQr, setShowQr] = useState(false);
  const [now, setNow] = useState(0);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const payment = usePayment(roomId, password, () => undefined);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  if (!paid) return null;
  const split = splitAccessPrice(paid.price);
  const free = new Set(paid.previewFiles);
  const tree = listChildren(files, '');
  const total = files.reduce((sum, f) => sum + (f.originalFileSize || 0), 0);
  const phase = payment.phase;
  const done = phase === 'paid' || settings.pay?.access === 'full';
  const working = ['creating', 'connecting', 'signing', 'sending', 'confirming'].includes(phase);
  const step = done ? 3 : payment.invoice || working ? 2 : 1;
  const owner = paid.ownerName ?? 'the owner';
  const canBuy = settings.pay?.enabled && paid.onSale;

  const changeToken = (next: TPayToken) => {
    setToken(next);
    payment.reset();
    setShowQr(false);
  };
  const showPhoneQr = async () => {
    setShowQr(true);
    if (!payment.invoice || payment.invoice.token !== token || phase === 'expired') await payment.start({ kind: 'access', token });
  };
  const restore = async () => {
    const wallet = wallets.find(canSignMessage);
    if (!wallet) {
      setRestoreError('Open this page in the browser that has the wallet you paid with.');
      return;
    }
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreAccess(roomId, password, wallet);
      onUnlocked();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Could not restore access');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_480px] lg:overflow-hidden">
      <main className="flex min-w-0 flex-col gap-5 px-5 py-7 sm:px-10 lg:overflow-y-auto lg:px-14 lg:py-10">
        <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">
          ← All rooms
        </Link>
        <div>
          <p className="text-xs font-semibold tracking-[0.08em] text-violet-300">PAID ROOM</p>
          <h1 className="mt-1.5 text-[28px] font-bold text-slate-100 sm:text-[32px]">{settings.name}</h1>
        </div>
        <div className="flex max-w-xl items-center gap-3 rounded-[14px] border border-white/10 bg-[#0B1222] p-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-900 font-bold text-violet-100">{owner.replace('@', '').slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-slate-100">{owner}</span>
            <span className="text-xs text-emerald-300">{paid.ownerVerified ? 'ID verified with CAFECA · paid to a verified Solana address' : 'Seller'}</span>
          </span>
        </div>

        <section aria-labelledby="pay-inside" className="flex max-w-xl flex-col gap-2">
          <h2 id="pay-inside" className="text-xs font-semibold tracking-[0.08em] text-slate-400">
            {paid.previewNames ? `WHAT’S INSIDE · ${files.length} ${files.length === 1 ? 'FILE' : 'FILES'} · ${formatBytes(total)}` : 'FREE PREVIEW'}
          </h2>
          {files.length > 0 ? (
            <ul className="overflow-hidden rounded-[14px] border border-white/10">
              {tree.folders.map(folder => (
                <li key={folder.path} className="flex justify-between gap-3 border-b border-white/10 px-3.5 py-3 text-[13px] text-slate-200 last:border-b-0">
                  <span className="min-w-0 truncate">
                    ▸ {folder.name} ({folder.count} {folder.count === 1 ? 'file' : 'files'})
                  </span>
                  <span className="shrink-0 font-mono text-slate-400">{formatBytes(folder.size)}</span>
                </li>
              ))}
              {tree.files.map(file => (
                <li key={file.filename} className="flex items-center justify-between gap-3 border-b border-white/10 px-3.5 py-3 text-[13px] text-slate-200 last:border-b-0">
                  <span className="min-w-0 truncate">{file.filename}</span>
                  {free.has(file.filename) ? (
                    <button type="button" onClick={() => onDownloadFree(file.filename)} className="shrink-0 text-xs font-semibold text-emerald-300 hover:text-emerald-200">
                      Free preview · Download
                    </button>
                  ) : (
                    <span className="shrink-0 font-mono text-slate-400">{formatBytes(file.originalFileSize || 0)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-slate-400">File names are shown after you unlock the room.</p>
          )}
          {settings.expiresAt && <p className="text-xs text-slate-400">Open until {formatDate(settings.expiresAt)}</p>}
        </section>
      </main>

      <aside aria-label="Checkout" className="flex flex-col gap-[18px] border-t border-white/10 bg-[#0B1222] px-5 py-7 sm:px-8 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:py-10">
        <ol aria-label="Steps" className="grid grid-cols-3 gap-1.5 text-xs">
          {['Choose', 'Pay', 'Open room'].map((label, i) => {
            const n = i + 1;
            const state = n < step ? 'done' : n === step ? 'current' : 'next';
            return (
              <li
                key={label}
                aria-current={state === 'current' ? 'step' : undefined}
                className={`border-t-[3px] pt-2 ${state === 'done' ? 'border-emerald-500 text-emerald-300' : state === 'current' ? 'border-blue-500 font-bold text-white' : 'border-slate-700 text-slate-500'}`}
              >
                {state === 'done' ? '✓ ' : ''}
                {label}
              </li>
            );
          })}
        </ol>

        {done ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-emerald-800 bg-emerald-950/60 p-5 text-center">
            <p className="text-lg font-bold text-slate-100">You can open the room now</p>
            {payment.invoice?.signature ? (
              <p className="text-[13px] text-emerald-200">
                Paid {formatAmount(payment.invoice.amount)} {payment.invoice.token} · <TxLink signature={payment.invoice.signature} />
              </p>
            ) : (
              <p className="text-[13px] text-emerald-200">Your access is saved for this room.</p>
            )}
            <button type="button" onClick={onUnlocked} className="h-12 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500">
              Open the room
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-300">Room access</span>
              <span className="font-mono text-[28px] font-bold text-white">
                {formatAmount(paid.price)} <span className="text-base">{token}</span>
              </span>
            </div>
            {!canBuy ? (
              <p className="rounded-xl border border-amber-500/40 bg-amber-950/30 px-3.5 py-3 text-[13px] text-amber-200">
                {settings.pay?.enabled ? 'Sales are paused: this room ends in less than 30 days. The owner needs to extend it first.' : 'Payments aren’t available on this server right now.'}
              </p>
            ) : (
              <>
                <TokenToggle value={token} onChange={changeToken} disabled={working} />
                <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <WalletButtons wallets={wallets} disabled={working} label={w => `Pay with ${w.name}`} onPay={wallet => payment.payWith(wallet, { kind: 'access', token })} />
                  <PhoneQr invoice={payment.invoice} showing={showQr} onShow={showPhoneQr} />
                </div>
                <PayStatus phase={phase} error={payment.error} invoice={payment.invoice} now={now} />
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-[13px]">
                  <dt className="text-slate-400">To {owner}</dt>
                  <dd className="font-mono text-slate-100">{formatAmount(split.owner)}</dd>
                  <dt className="text-slate-400">DropHere fee · 10%</dt>
                  <dd className="font-mono text-slate-100">{formatAmount(split.fee)}</dd>
                  <dt className="text-slate-400">Network fee</dt>
                  <dd className="text-emerald-300">Paid by DropHere</dd>
                </dl>
              </>
            )}
            <p className="text-[11px] leading-relaxed text-slate-400">
              One Solana transaction sends {formatAmount(split.owner)} to {owner} and {formatAmount(split.fee)} to DropHere — DropHere never holds the owner’s money. Access is saved to your CAFECA account if you’re signed in, otherwise to this browser and the wallet that paid. Payments can’t be reversed; refunds are up to the owner.
            </p>
          </>
        )}
        <span className="hidden flex-1 lg:block" />
        {!done && (
          <div className="text-xs text-slate-400">
            Already paid on another device?{' '}
            <button type="button" disabled={restoring} onClick={restore} className="text-blue-300 underline-offset-2 hover:underline disabled:opacity-50">
              {restoring ? 'Check your wallet…' : 'Restore access with your wallet'}
            </button>
            {restoreError && <p className="mt-1.5 text-red-300">{restoreError}</p>}
          </div>
        )}
      </aside>
    </div>
  );
}
