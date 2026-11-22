import { useCallback, useEffect, useState } from 'react';
import type { ILariaMetadata } from '@/lib/file_operator';
import type { IRoomSettings } from '@/lib/room_store';
import { memberHeaders } from '@/lib/member';
import { useAuth } from '@/lib/use_auth';
import { canSignMessage, useSolanaWallets } from '@/lib/solana_wallet';
import { fetchSeller, updateSeller, usePayment, verifyPayout, type ISellerState } from '@/lib/pay_client';
import { DAY_MS, GB, MIN_ACCESS_PRICE, PAID_MIN_DAYS, ROOM_PLANS, formatAmount, parseAmount, shortAddress, splitAccessPrice, type TPayToken } from '@/lib/pay_plans';
import { PayStatus, PhoneQr, TokenToggle, TxLink, WalletButtons } from '@/components/pay_widgets';
import ToggleSwitch from '@/components/toggle_switch';

/**
 * Info: (20261120 - Luphia)
 * 延長房間 C：側欄的「Plan」分頁 (所有人都可以替房間延長)
 * - 目前方案、剩餘時間與容量；30 天 / 90 天 / 1 年方案；瀏覽器錢包或手機掃碼付款 (平台代付手續費)
 * - 房主：付費進房設定 (價格、免費預覽、收款地址、CAFECA 實名) 與銷售紀錄
 */

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const gbText = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

function remainingText(ms: number) {
  if (ms <= 0) return 'ended';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

interface IRoomPlanPanelProps {
  roomId: string;
  password: string | null;
  settings: IRoomSettings;
  files: ILariaMetadata[];
  now: number;
  onChanged: () => void;
}

export default function RoomPlanPanel({ roomId, password, settings, files, now, onChanged }: IRoomPlanPanelProps) {
  const pay = settings.pay;
  const wallets = useSolanaWallets();
  const [planId, setPlanId] = useState('90d');
  const [token, setToken] = useState<TPayToken>('USDC');
  const [showQr, setShowQr] = useState(false);
  const payment = usePayment(roomId, password, onChanged);
  const plan = ROOM_PLANS.find(p => p.id === planId) ?? ROOM_PLANS[1];
  const working = ['creating', 'connecting', 'signing', 'sending', 'confirming'].includes(payment.phase);
  const expiresAt = settings.expiresAt;
  const left = expiresAt ? expiresAt - now : null;
  const used = pay?.usedBytes ?? 0;
  const capacity = pay?.plan.capacityBytes ?? 0;
  const warn = left !== null && left < 24 * 3600 * 1000;

  const choose = (next: { planId?: string; token?: TPayToken }) => {
    if (next.planId) setPlanId(next.planId);
    if (next.token) setToken(next.token);
    payment.reset();
    setShowQr(false);
  };
  const showPhoneQr = async () => {
    setShowQr(true);
    if (!payment.invoice || phaseIsStale(payment.phase)) await payment.start({ kind: 'extend', planId, token });
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <section
        aria-label="Current plan"
        className={`rounded-[14px] border p-3.5 ${warn ? 'border-amber-800 bg-amber-950/40' : 'border-white/10 bg-[#0B1222]'}`}
      >
        <p className={`text-xs ${warn ? 'text-amber-300' : 'text-slate-300'}`}>
          {pay?.plan.paid ? 'Paid plan' : 'Free room'} · {expiresAt ? (left !== null && left > 0 ? `ends in ${remainingText(left)} · ${formatDate(expiresAt)}` : 'ended') : 'no end date'}
        </p>
        {capacity > 0 && (
          <>
            <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-800" role="img" aria-label={`${gbText(used)} of ${gbText(capacity)} used`}>
              <div className={`h-full rounded-full ${used / capacity > 0.9 ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, (used / capacity) * 100)}%` }} />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              {gbText(used)} of {gbText(capacity)} used
            </p>
          </>
        )}
      </section>

      {!pay?.enabled ? (
        <p className="text-xs text-slate-400">Paying to keep rooms longer isn’t available on this server.</p>
      ) : payment.phase === 'paid' && payment.invoice ? (
        <section aria-label="Receipt" className="flex flex-col gap-2 rounded-[14px] border border-emerald-800 bg-emerald-950/60 p-4 text-center">
          <p className="text-[15px] font-bold text-slate-100">Kept until {payment.invoice.result?.expiresAt ? formatDate(payment.invoice.result.expiresAt) : 'later'}</p>
          <p className="text-xs text-emerald-200">
            Paid {formatAmount(payment.invoice.amount)} {payment.invoice.token} · {payment.invoice.signature && <TxLink signature={payment.invoice.signature} />}
          </p>
          <button type="button" onClick={payment.reset} className="mt-1 h-9 rounded-lg border border-white/10 text-xs font-semibold text-slate-200 hover:bg-white/5">
            Done
          </button>
        </section>
      ) : (
        <section id="plan-extend-section" aria-labelledby="plan-extend" className="flex scroll-mt-4 flex-col gap-3">
          <h3 id="plan-extend" className="text-[13px] font-bold text-slate-100">
            Keep this room longer
          </h3>
          <div role="radiogroup" aria-label="How long" className="grid grid-cols-3 gap-2">
            {ROOM_PLANS.map(p => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={planId === p.id}
                disabled={working}
                onClick={() => choose({ planId: p.id })}
                className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-3 text-[13px] ${planId === p.id ? 'border-blue-500 bg-[#0B1530] font-bold text-white' : 'border-white/10 text-slate-200 hover:bg-white/5'}`}
              >
                {p.days === 365 ? '1 year' : `${p.days} days`}
                <span className="font-mono text-sm font-bold">{formatAmount(p.price).replace(/\.00$/, '')}</span>
                <span className={`text-[10px] font-normal ${planId === p.id ? 'text-blue-200' : 'text-slate-400'}`}>{p.gb} GB</span>
              </button>
            ))}
          </div>
          <TokenToggle value={token} onChange={t => choose({ token: t })} disabled={working} />
          <p className="text-[11px] text-emerald-300">Prices in USDC or USDT on Solana · network fee paid by DropHere</p>
          <WalletButtons
            wallets={wallets}
            disabled={working}
            label={w => `Extend ${plan.days === 365 ? '1 year' : `${plan.days} days`} · ${formatAmount(plan.price).replace(/\.00$/, '')} ${token}${wallets.length > 1 ? ` · ${w.name}` : ''}`}
            onPay={wallet => payment.payWith(wallet, { kind: 'extend', planId, token })}
          />
          <PhoneQr invoice={payment.invoice} showing={showQr} onShow={showPhoneQr} />
          <PayStatus phase={payment.phase} error={payment.error} invoice={payment.invoice} now={now} />
          <p className="text-[11px] leading-relaxed text-slate-400">
            Anyone in the room can extend it. Time is added to the current end date; space becomes the larger of your plans.
          </p>
        </section>
      )}

      {settings.isOwner && pay?.enabled && <SellerSection roomId={roomId} password={password} settings={settings} files={files} now={now} onChanged={onChanged} />}
    </div>
  );
}

const phaseIsStale = (phase: string) => phase === 'expired' || phase === 'idle';

type TStepState = 'done' | 'current' | 'todo';

// Info: (20261122 - Luphia) 設定步驟：編號 (完成為勾)、標題、說明與這一步的操作
function SetupStep({ n, state, title, children }: { n: number; state: TStepState; title: string; children?: React.ReactNode }) {
  return (
    <li aria-current={state === 'current' ? 'step' : undefined} className={`flex gap-3 rounded-xl border p-3 ${state === 'current' ? 'border-violet-600 bg-violet-950/40' : 'border-white/10'}`}>
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${state === 'done' ? 'bg-emerald-500 text-emerald-950' : state === 'current' ? 'bg-violet-500 text-white' : 'border border-slate-600 text-slate-400'}`}
      >
        {state === 'done' ? '✓' : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className={`text-[13px] font-semibold ${state === 'todo' ? 'text-slate-400' : 'text-slate-100'}`}>
          <span className="sr-only">{state === 'done' ? 'Done: ' : state === 'current' ? 'Next: ' : 'Later: '}</span>
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

function SellerSection({ roomId, password, settings, files, now, onChanged }: IRoomPlanPanelProps) {
  const wallets = useSolanaWallets();
  const signers = wallets.filter(canSignMessage);
  const auth = useAuth();
  const [state, setState] = useState<ISellerState | null>(null);
  const [priceText, setPriceText] = useState('5.00');
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [extendToken, setExtendToken] = useState<TPayToken>('USDC');
  const [showQr, setShowQr] = useState(false);
  const extend = usePayment(roomId, password, onChanged);
  const minPlan = ROOM_PLANS.find(p => p.days >= PAID_MIN_DAYS) ?? ROOM_PLANS[0];

  const load = useCallback(() => {
    fetchSeller(roomId, password)
      .then(next => {
        setState(next);
        setPriceText(formatAmount(next.paid.price));
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load paid access'));
  }, [password, roomId]);
  // Info: (20261120 - Luphia) 房間設定更新 (例如有新的銷售) 時重新讀取
  useEffect(() => {
    load();
  }, [load, settings]);

  if (!state) return error ? <p className="text-xs text-red-300">{error}</p> : null;
  const { paid, seller } = state;
  const kycOk = seller.signedIn && (seller.kyc ?? -1) >= seller.required;
  const longEnough = !settings.expiresAt || settings.expiresAt >= now + PAID_MIN_DAYS * DAY_MS;
  const payoutOk = !!paid.payout && !!paid.payoutVerifiedAt;
  const price = parseAmount(priceText);
  const split = price ? splitAccessPrice(price) : null;
  const rootFiles = files.filter(f => !f.filename.includes('/')).slice(0, 30);
  const extending = ['creating', 'connecting', 'signing', 'sending', 'confirming'].includes(extend.phase);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      load();
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: Record<string, unknown>) => run(() => updateSeller(roomId, password, patch));
  // Info: (20261122 - Luphia) 售價：離開欄位或按 Enter 時自動儲存
  const savePrice = async () => {
    if (!price || price === paid.price) return;
    if (await save({ price })) setPriceNote('Saved');
  };

  const downloadCsv = async () => {
    const res = await fetch(`/api/v1/room/${roomId}/paid?format=csv`, { headers: memberHeaders({}, password) });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `room-${roomId}-sales.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const priceField = (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          value={priceText}
          inputMode="decimal"
          aria-label="Price"
          disabled={busy}
          onChange={e => {
            setPriceText(e.target.value);
            setPriceNote(null);
          }}
          onBlur={savePrice}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          className="h-10 w-28 rounded-[10px] border border-violet-600 bg-[#020617] px-3 font-mono text-base font-bold text-white focus:outline-none focus:ring-2 focus:ring-violet-500/60"
        />
        USDC or USDT
        {priceNote && <span className="text-emerald-300">✓ {priceNote}</span>}
      </label>
      <p className="text-[11px] text-slate-400">
        {split ? `You receive ${formatAmount(split.owner)} per sale · DropHere fee ${formatAmount(split.fee)}` : `Enter a price of at least ${formatAmount(MIN_ACCESS_PRICE)}`}
      </p>
    </div>
  );

  const previews = (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 text-xs text-slate-200">
      <legend className="mb-1.5 p-0 text-xs font-bold">Free before paying</legend>
      <label className="flex items-center gap-2">
        <input type="checkbox" aria-label="Show file names and sizes" checked={paid.previewNames} disabled={busy} onChange={e => save({ previewNames: e.target.checked })} className="h-4 w-4 accent-violet-500" />
        Show file names and sizes
      </label>
      {rootFiles.length === 0 ? (
        <p className="text-[11px] text-slate-400">Upload files to choose some as free previews.</p>
      ) : (
        rootFiles.map(f => (
          <label key={f.filename} className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label={`${f.filename} as a free preview`}
              checked={paid.previewFiles.includes(f.filename)}
              disabled={busy}
              onChange={e => save({ previewFiles: e.target.checked ? [...paid.previewFiles, f.filename] : paid.previewFiles.filter(n => n !== f.filename) })}
              className="h-4 w-4 accent-violet-500"
            />
            <span className="min-w-0 truncate">{f.filename} · free preview</span>
          </label>
        ))
      )}
    </fieldset>
  );

  const errorLine = error && (
    <p role="alert" className="rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-200">
      {error}
    </p>
  );

  // --- Info: (20261122 - Luphia) 販售中：暫停開關、售價、免費預覽、銷售紀錄 ---
  if (paid.enabled) {
    return (
      <section aria-label="Paid access" className="flex flex-col gap-3 rounded-[14px] border border-violet-800 p-3.5">
        <ToggleSwitch
          id="paid-access"
          label="Selling access to this room"
          description="Visitors pay you directly · 10% DropHere fee · turn off to pause sales"
          checked
          disabled={busy}
          onChange={enabled => save({ enabled })}
        />
        {priceField}
        {previews}
        {errorLine}
        <div className="flex items-center gap-2 border-t border-white/10 pt-3">
          <p className="flex-1 text-xs text-slate-300">
            {state.totals.count} {state.totals.count === 1 ? 'sale' : 'sales'} · you received <span className="font-mono text-emerald-300">{formatAmount(state.totals.received)} USDC/USDT</span>
          </p>
          {state.totals.count > 0 && (
            <button type="button" onClick={downloadCsv} className="h-8 rounded-lg border border-white/10 px-2.5 text-[11px] font-semibold text-slate-200 hover:bg-white/5">
              Export CSV
            </button>
          )}
        </div>
        {state.sales.length > 0 && (
          <ul className="flex flex-col text-[11px]">
            {state.sales.slice(0, 8).map(sale => (
              <li key={sale.signature} className="flex items-center gap-2 border-t border-white/5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-slate-300">{sale.buyerName ?? shortAddress(sale.payer)}</span>
                <span className="font-mono text-emerald-300">{formatAmount(sale.owner)} {sale.token}</span>
                <TxLink signature={sale.signature} />
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  // --- Info: (20261122 - Luphia) 尚未販售：沒有在建立時選擇收費的房間先收合 ---
  if (!paid.setupPending && !expanded) {
    return (
      <section aria-label="Paid access" className="flex items-center gap-3 rounded-[14px] border border-white/10 p-3.5">
        <p className="min-w-0 flex-1 text-[13px] text-slate-200">
          Charge for access
          <span className="block text-[11px] text-slate-400">Visitors pay you directly in USDC or USDT · 10% DropHere fee</span>
        </p>
        <button type="button" onClick={() => setExpanded(true)} className="h-9 shrink-0 rounded-lg border border-violet-600 px-3 text-xs font-semibold text-violet-100 hover:bg-violet-950">
          Set up
        </button>
      </section>
    );
  }

  const steps = [kycOk, longEnough, payoutOk, !!price && price >= MIN_ACCESS_PRICE];
  const firstOpen = steps.findIndex(done => !done);
  const stepState = (i: number): TStepState => (steps[i] ? 'done' : i === firstOpen ? 'current' : 'todo');
  const ready = firstOpen === -1;

  return (
    <section aria-label="Paid access" className="flex flex-col gap-3 rounded-[14px] border border-violet-800 p-3.5">
      <div>
        <h3 className="text-[13px] font-bold text-slate-100">Set up paid access</h3>
        <p className="text-[11px] text-slate-400">Visitors pay you directly in USDC or USDT on Solana · 10% DropHere fee</p>
      </div>
      <ol className="flex flex-col gap-2">
        <SetupStep n={1} state={stepState(0)} title="Verify your ID with CAFECA">
          {kycOk ? (
            <p className="text-xs text-emerald-300">Signed in{seller.handle ? ` as @${seller.handle}` : ''} · ID verified</p>
          ) : (
            <>
              <p className="text-xs text-slate-300">{seller.signedIn ? `Your account needs ID verification (level ${seller.required}). Verify in CAFECA, then sign in again.` : 'Sign in with an ID-verified CAFECA account.'}</p>
              <button type="button" disabled={!auth.enabled || auth.busy} onClick={auth.signIn} className="h-9 self-start rounded-lg bg-violet-600 px-3 text-xs font-bold text-white hover:bg-violet-500 disabled:opacity-50">
                {seller.signedIn ? 'Sign in again' : 'Sign in with CAFECA'}
              </button>
            </>
          )}
        </SetupStep>

        <SetupStep n={2} state={stepState(1)} title={`Keep the room open ${PAID_MIN_DAYS}+ days`}>
          {longEnough ? (
            <p className="text-xs text-emerald-300">Open until {settings.expiresAt ? formatDate(settings.expiresAt) : 'no end date'}</p>
          ) : extend.phase === 'paid' ? (
            <p className="text-xs text-emerald-300">Extended · updating…</p>
          ) : (
            <>
              <p className="text-xs text-slate-300">
                Buyers need time to use what they paid for. Extend {minPlan.days} days for {formatAmount(minPlan.price).replace(/\.00$/, '')} {extendToken}.
              </p>
              <TokenToggle value={extendToken} onChange={t => {
                  setExtendToken(t);
                  extend.reset();
                  setShowQr(false);
                }} disabled={extending} />
              <WalletButtons
                wallets={wallets}
                disabled={extending || stepState(1) !== 'current'}
                label={w => `Extend ${minPlan.days} days · ${formatAmount(minPlan.price).replace(/\.00$/, '')} ${extendToken}${wallets.length > 1 ? ` · ${w.name}` : ''}`}
                onPay={wallet => extend.payWith(wallet, { kind: 'extend', planId: minPlan.id, token: extendToken })}
              />
              <PhoneQr
                invoice={extend.invoice}
                showing={showQr}
                onShow={async () => {
                  setShowQr(true);
                  if (!extend.invoice || phaseIsStale(extend.phase)) await extend.start({ kind: 'extend', planId: minPlan.id, token: extendToken });
                }}
              />
              <PayStatus phase={extend.phase} error={extend.error} invoice={extend.invoice} now={now} />
            </>
          )}
        </SetupStep>

        <SetupStep n={3} state={stepState(2)} title="Choose the wallet that receives payments">
          {payoutOk && paid.payout && <p className="text-xs text-emerald-300">Paid to Solana address <span className="font-mono">{shortAddress(paid.payout)}</span> · proven by your signature</p>}
          {(!payoutOk || stepState(2) === 'current') && (
            <p className="text-xs text-slate-300">Pick a Solana wallet and sign a short message to prove the address is yours. Money goes straight there — DropHere never holds it.</p>
          )}
          {signers.length === 0 ? (
            <p className="text-xs text-amber-200">No Solana wallet in this browser. Install Phantom, Solflare or Backpack, or turn on Solana in MetaMask.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {signers.map(wallet => (
                <button
                  key={wallet.name}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => verifyPayout(roomId, password, wallet))}
                  className={`flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold disabled:opacity-50 ${payoutOk ? 'border border-white/10 text-slate-200 hover:bg-white/5' : 'bg-violet-600 text-white hover:bg-violet-500'}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {wallet.icon && <img src={wallet.icon} alt="" className="h-4 w-4 rounded" />}
                  {payoutOk ? `Change to ${wallet.name}` : wallet.name}
                  <span className="rounded bg-black/30 px-1 text-[10px] font-normal">Solana</span>
                </button>
              ))}
            </div>
          )}
        </SetupStep>

        <SetupStep n={4} state={stepState(3)} title="Set your price">
          {priceField}
        </SetupStep>
      </ol>

      {previews}
      {errorLine}

      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => save({ enabled: true })}
        className="h-11 rounded-xl bg-violet-600 text-sm font-bold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
      >
        {ready ? `Start selling · ${price ? formatAmount(price) : ''} USDC or USDT` : `Start selling · ${steps.filter(Boolean).length} of 4 steps done`}
      </button>
      {!paid.setupPending && (
        <button type="button" onClick={() => setExpanded(false)} className="self-center text-[11px] text-slate-400 hover:text-slate-200">
          Not now
        </button>
      )}
    </section>
  );
}
