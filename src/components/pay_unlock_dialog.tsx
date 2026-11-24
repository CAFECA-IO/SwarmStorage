import { useEffect, useState } from 'react';
import DialogShell from '@/components/dialog_shell';
import { LockIcon, XIcon } from '@/components/icons';
import type { ILariaMetadata } from '@/lib/file_operator';
import type { IRoomSettings } from '@/lib/room_store';
import { formatBytes } from '@/lib/utils';
import { useSolanaWallets, canSignMessage } from '@/lib/solana_wallet';
import { restoreAccess, usePayment } from '@/lib/pay_client';
import { PAY_TOKEN, formatAmount, splitAccessPrice } from '@/lib/pay_plans';
import { PayStatus, PhoneQr, TxLink, WalletButtons } from '@/components/pay_widgets';

/**
 * Info: (20261124 - Luphia)
 * 付費房解鎖 (A：房間內的對話框，不放在聊天欄)
 * - 付費房沒買的人照常看到房間 (檔名與大小、免費預覽依房主設定)，從橫幅或鎖住的檔案開啟
 * - 瀏覽器錢包或手機掃碼付款 (USDC，平台代付手續費) → 進房；也可以用付款錢包恢復權限
 */

interface IPayUnlockDialogProps {
  roomId: string;
  password: string | null;
  settings: IRoomSettings;
  files: ILariaMetadata[];
  onUnlocked: () => void;
  onClose: () => void;
}

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const token = PAY_TOKEN;

export default function PayUnlockDialog({ roomId, password, settings, files, onUnlocked, onClose }: IPayUnlockDialogProps) {
  const paid = settings.pay?.paid ?? null;
  const wallets = useSolanaWallets();
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
  const total = files.reduce((sum, f) => sum + (f.originalFileSize || 0), 0);
  const freeCount = paid.previewFiles.filter(name => files.some(f => f.filename === name)).length;
  const phase = payment.phase;
  const done = phase === 'paid' || settings.pay?.access === 'full';
  const working = ['creating', 'connecting', 'signing', 'sending', 'confirming'].includes(phase);
  const owner = paid.ownerName ?? 'the owner';
  const canBuy = settings.pay?.enabled && paid.onSale;

  const showPhoneQr = async () => {
    setShowQr(true);
    if (!payment.invoice || phase === 'expired') await payment.start({ kind: 'access', token });
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
    <DialogShell label={`Unlock ${settings.name}`} onClose={onClose} mobile="sheet" className="sm:w-[460px]">
      <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-slate-700 sm:hidden" aria-hidden="true" />
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 pb-6 pt-4 sm:px-6 sm:pt-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-900 text-violet-100">
            <LockIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-bold text-white">Unlock {settings.name}</h2>
            <p className="text-xs text-slate-400">
              by {owner}
              {paid.ownerVerified && <span className="text-emerald-300"> · ✓ ID verified with CAFECA</span>}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 hover:bg-white/5">
            <XIcon className="h-5 w-5 text-slate-400" />
          </button>
        </div>

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
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 rounded-[14px] border border-white/10 bg-[#0B1222] p-3.5 text-[13px]">
              <dt className="text-slate-400">Inside</dt>
              <dd className="text-right text-slate-200">
                {paid.previewNames ? `${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatBytes(total)}` : 'Shown after you unlock'}
              </dd>
              {freeCount > 0 && (
                <>
                  <dt className="text-slate-400">Free to see now</dt>
                  <dd className="text-right text-emerald-300">{freeCount === 1 ? '1 file' : `${freeCount} files`}</dd>
                </>
              )}
              <dt className="text-slate-400">Access</dt>
              <dd className="text-right text-slate-200">{settings.expiresAt ? `Until the room closes · ${formatDate(settings.expiresAt)}` : 'As long as the room is open'}</dd>
              <div className="col-span-2 mt-1.5 flex items-baseline justify-between border-t border-white/10 pt-2">
                <dt className="font-semibold text-white">Total</dt>
                <dd className="font-mono text-lg font-bold text-white">
                  {formatAmount(paid.price)} {token}
                </dd>
              </div>
            </dl>

            {!canBuy ? (
              <p className="rounded-xl border border-amber-500/40 bg-amber-950/30 px-3.5 py-3 text-[13px] text-amber-200">
                {settings.pay?.enabled ? 'Sales are paused: this room ends in less than 30 days. The owner needs to extend it first.' : 'Payments aren’t available on this server right now.'}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <WalletButtons wallets={wallets} disabled={working} label={w => `Pay with ${w.name}`} onPay={wallet => payment.payWith(wallet, { kind: 'access', token })} />
                  <PhoneQr invoice={payment.invoice} showing={showQr} onShow={showPhoneQr} />
                </div>
                <PayStatus phase={phase} error={payment.error} invoice={payment.invoice} now={now} />
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-slate-400">To {owner}</dt>
                  <dd className="font-mono text-slate-200">{formatAmount(split.owner)}</dd>
                  <dt className="text-slate-400">DropHere fee · 10%</dt>
                  <dd className="font-mono text-slate-200">{formatAmount(split.fee)}</dd>
                  <dt className="text-slate-400">Network fee</dt>
                  <dd className="text-emerald-300">Paid by DropHere</dd>
                </dl>
              </>
            )}
            <p className="text-[11px] leading-relaxed text-slate-400">
              One Solana transaction sends {formatAmount(split.owner)} USDC to {owner} and {formatAmount(split.fee)} USDC to DropHere — DropHere never holds the owner’s money. Access is saved to your CAFECA account if you’re signed in, otherwise to this browser and the wallet that paid. Payments can’t be reversed; refunds are up to the owner.
            </p>
            <div className="text-center text-xs text-slate-400">
              Paid on another device?{' '}
              <button type="button" disabled={restoring} onClick={restore} className="text-blue-300 underline-offset-2 hover:underline disabled:opacity-50">
                {restoring ? 'Check your wallet…' : 'Restore with your wallet'}
              </button>
              {restoreError && <p className="mt-1.5 text-red-300">{restoreError}</p>}
            </div>
          </>
        )}
      </div>
    </DialogShell>
  );
}
