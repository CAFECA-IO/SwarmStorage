import { QRCodeSVG } from 'qrcode.react';
import type { Wallet } from '@wallet-standard/base';
import { formatAmount, type TPayToken } from '@/lib/pay_plans';
import type { TInvoiceView, TPayPhase } from '@/lib/pay_client';
import { explorerTx } from '@/lib/pay_client';

/**
 * Info: (20261120 - Luphia)
 * 付款共用元件：錢包按鈕、手機掃碼 (Solana Pay)、付款狀態
 */

export function WalletButtons({
  wallets,
  label,
  disabled,
  onPay,
}: {
  wallets: Wallet[];
  label: (wallet: Wallet) => string;
  disabled: boolean;
  onPay: (wallet: Wallet) => void;
}) {
  if (wallets.length === 0) {
    return <p className="rounded-[10px] border border-white/10 bg-[#0B1222] px-3 py-2.5 text-xs leading-relaxed text-slate-400">No Solana wallet in this browser. Scan the code with Phantom, Solflare or another Solana wallet on your phone.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {wallets.map((wallet, i) => (
        <button
          key={wallet.name}
          type="button"
          disabled={disabled}
          onClick={() => onPay(wallet)}
          className={`flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${i === 0 ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-white/10 text-slate-100 hover:bg-white/5'}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {wallet.icon && <img src={wallet.icon} alt="" className="h-5 w-5 rounded" />}
          {label(wallet)}
        </button>
      ))}
    </div>
  );
}

export function PhoneQr({ invoice, onShow, showing }: { invoice: TInvoiceView | null; onShow: () => void; showing: boolean }) {
  if (!showing || !invoice) {
    return (
      <button type="button" onClick={onShow} className="h-10 rounded-xl border border-white/10 px-3 text-[13px] font-semibold text-slate-200 hover:bg-white/5">
        Pay from your phone
      </button>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="rounded-xl bg-white p-2">
        <QRCodeSVG value={invoice.payUrl} size={168} marginSize={1} title="Scan with a Solana wallet to pay" />
      </div>
      <a href={invoice.payUrl} className="text-xs text-blue-300 underline-offset-2 hover:underline sm:hidden">
        Open in your wallet app
      </a>
      <p className="text-center text-[11px] text-slate-400">Phantom, Solflare, Backpack… No SOL needed.</p>
    </div>
  );
}

const PHASE_TEXT: Record<TPayPhase, string> = {
  idle: '',
  creating: 'Preparing the payment…',
  waiting: 'Watching Solana for your payment',
  connecting: 'Connecting to your wallet…',
  signing: 'Approve the payment in your wallet',
  sending: 'Sending to Solana…',
  confirming: 'Confirming on Solana… usually a few seconds',
  paid: 'Paid',
  expired: 'This payment request expired. Start again.',
};

export function PayStatus({ phase, error, invoice, now }: { phase: TPayPhase; error: string | null; invoice: TInvoiceView | null; now: number }) {
  if (error) {
    return (
      <p role="alert" className="rounded-xl border border-red-500/40 bg-red-950/30 px-3.5 py-2.5 text-[13px] text-red-200">
        {error}
      </p>
    );
  }
  if (phase === 'idle' || phase === 'paid') return null;
  const left = invoice && phase === 'waiting' ? Math.max(0, invoice.expiresAt - now) : 0;
  const active = phase !== 'expired';
  return (
    <p role="status" className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] ${active ? 'border-blue-900 bg-[#0B1530] text-blue-100' : 'border-amber-500/40 bg-amber-950/30 text-amber-200'}`}>
      {active && (
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-400" />
        </span>
      )}
      <span className="min-w-0 flex-1">{PHASE_TEXT[phase]}</span>
      {left > 0 && (
        <span className="font-mono text-xs">
          {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}
        </span>
      )}
    </p>
  );
}

export function TxLink({ signature }: { signature: string }) {
  return (
    <a href={explorerTx(signature)} target="_blank" rel="noreferrer" className="font-mono text-blue-300 hover:text-blue-200">
      {signature.slice(0, 4)}…{signature.slice(-4)} ↗
    </a>
  );
}

export const priceText = (micro: number, token: TPayToken) => `${formatAmount(micro)} ${token}`;
