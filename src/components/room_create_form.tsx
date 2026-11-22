import { useEffect, useState, type FormEvent } from 'react';
import ToggleSwitch from '@/components/toggle_switch';
import { ApiCode } from '@/lib/status';
import { addRecentRoom, memberHeaders } from '@/lib/member';
import { useAuth } from '@/lib/use_auth';
import { PAID_MIN_DAYS, ROOM_PLANS, formatAmount, parseAmount, splitAccessPrice } from '@/lib/pay_plans';

interface IPayPublicConfig {
  enabled: boolean;
  sellerKyc: number;
  minPrice: number;
  maxPrice: number;
}

export const RETENTION_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 10, label: '10 m' },
  { minutes: 60, label: '1 h' },
  { minutes: 1440, label: '1 d' },
  { minutes: 10080, label: '1 w' },
];

interface IRoomCreateFormProps {
  // Info: (20261106 - Luphia) panel = 桌面版右側表單；steps = 手機版三步驟
  variant: 'panel' | 'steps';
  // Info: (20261122 - Luphia) paidSetup：建立的是收費房 (進房後直接開啟 Plan 完成設定)
  onCreated: (roomNumber: string, options?: { paidSetup?: boolean }) => void;
  onCancel?: () => void;
}

/**
 * Info: (20261106 - Luphia)
 * 建立房間表單：名稱、誰可以上傳、下載、是否公開、密碼、保存時間
 * Info: (20261122 - Luphia) 付款功能開啟時可選擇收費 (需要 CAFECA 實名)；建立後在 Plan 分頁完成設定
 */
export default function RoomCreateForm({ variant, onCreated, onCancel }: IRoomCreateFormProps) {
  const [name, setName] = useState('');
  const [everyoneUploads, setEveryoneUploads] = useState(true);
  const [allowDownload, setAllowDownload] = useState(true);
  const [listed, setListed] = useState(true);
  const [password, setPassword] = useState('');
  const [minutes, setMinutes] = useState(1440);
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [payConfig, setPayConfig] = useState<IPayPublicConfig | null>(null);
  const [charge, setCharge] = useState(false);
  const [priceText, setPriceText] = useState('5.00');
  const auth = useAuth();

  // Info: (20261122 - Luphia) 伺服器有開啟付款時才顯示收費選項
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/pay/config', { cache: 'no-store' })
      .then(res => res.json())
      .then(data => {
        if (!cancelled && data.code === ApiCode.OK && data.payload?.enabled) setPayConfig(data.payload as IPayPublicConfig);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const price = parseAmount(priceText);
  const kycOk = !!auth.user && (auth.user.kyc ?? -1) >= (payConfig?.sellerKyc ?? 2);
  const priceOk = !!price && !!payConfig && price >= payConfig.minPrice && price <= payConfig.maxPrice;
  const paidBlocked = charge && (!kycOk || !priceOk);

  const idPrefix = `create-${variant}`;

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/v1/room', {
        method: 'POST',
        headers: memberHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name,
          listed,
          uploadPolicy: everyoneUploads ? 'everyone' : 'owner',
          allowDownload,
          password: password || null,
          minutes,
          ...(charge && price ? { paid: { price } } : {}),
        }),
      });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message || 'Could not create the room');
      addRecentRoom(data.payload.roomNumber);
      onCreated(data.payload.roomNumber, { paidSetup: charge });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the room');
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (variant === 'steps' && step < 3) {
      setStep(step + 1);
      return;
    }
    submit();
  };

  const nameField = (
    <label className="flex flex-col gap-1.5 text-xs text-slate-400" htmlFor={`${idPrefix}-name`}>
      Room name
      <input
        id={`${idPrefix}-name`}
        aria-label="Room name"
        value={name}
        maxLength={60}
        onChange={e => setName(e.target.value)}
        placeholder="e.g. Lab data — kinetics"
        className="h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 pointer-coarse:text-base outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500/40"
      />
    </label>
  );

  const uploadChoice = (
    <fieldset className="flex flex-col gap-2">
      <legend className={variant === 'steps' ? 'sr-only' : 'mb-2 text-xs text-slate-400'}>Who can add files</legend>
      {(
        [
          [false, 'Only me', 'Good for handing files to others. Visitors can view and download.'],
          [true, 'Everyone in the room', 'Good for collecting files. Each person can delete only what they uploaded.'],
        ] as [boolean, string, string][]
      ).map(([value, title, description]) => {
        const selected = (charge ? false : everyoneUploads) === value;
        const locked = charge && value;
        return (
          <label
            key={title}
            htmlFor={`${idPrefix}-upload-${value ? 'everyone' : 'owner'}`}
            className={`flex gap-3 rounded-2xl border p-3.5 transition-colors ${locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${selected ? 'border-blue-500 bg-blue-950/60' : 'border-white/10 hover:bg-white/5'}`}
          >
            <input
              id={`${idPrefix}-upload-${value ? 'everyone' : 'owner'}`}
              aria-label={title}
              type="radio"
              name={`${idPrefix}-upload`}
              checked={selected}
              disabled={locked}
              onChange={() => setEveryoneUploads(value)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
            />
            <span>
              <span className="block text-sm font-semibold text-slate-100">{title}</span>
              <span className={`mt-1 block text-xs leading-5 ${selected ? 'text-blue-200' : 'text-slate-400'}`}>{locked ? 'Not available in a paid room: only you add files.' : description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );

  const downloadSwitch = (
    <ToggleSwitch
      id={`${idPrefix}-download`}
      label="Allow downloads"
      description={allowDownload ? 'Visitors can download files' : 'View only in the browser'}
      checked={allowDownload}
      onChange={setAllowDownload}
    />
  );

  const listedSwitch = (
    <ToggleSwitch
      id={`${idPrefix}-listed`}
      label="Show on home page"
      description={listed ? 'Anyone can find it in the room list' : 'Hidden: join by number or link only'}
      checked={listed}
      onChange={setListed}
    />
  );

  const passwordField = (
    <label className="flex flex-col gap-1.5 text-xs text-slate-400" htmlFor={`${idPrefix}-password`}>
      Password (optional)
      <input
        id={`${idPrefix}-password`}
        aria-label="Room password"
        type="password"
        value={password}
        maxLength={128}
        autoComplete="new-password"
        onChange={e => setPassword(e.target.value)}
        className="h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-slate-100 pointer-coarse:text-base outline-none focus:ring-2 focus:ring-blue-500/40"
      />
      <span className="text-[11px] text-slate-500">Password rooms still appear in the list with a lock.</span>
    </label>
  );

  const retention = (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-slate-400" id={`${idPrefix}-keep`}>
        Keep files for
      </span>
      <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-labelledby={`${idPrefix}-keep`}>
        {RETENTION_OPTIONS.map(option => (
          <button
            key={option.minutes}
            type="button"
            role="radio"
            aria-checked={minutes === option.minutes}
            onClick={() => setMinutes(option.minutes)}
            className={`h-10 rounded-xl text-[13px] ${minutes === option.minutes ? 'bg-blue-600 font-semibold text-white' : 'border border-white/10 text-slate-300 hover:bg-white/5'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  const cheapest = ROOM_PLANS.find(p => p.days >= PAID_MIN_DAYS) ?? ROOM_PLANS[0];
  const split = price ? splitAccessPrice(price) : null;
  const paidSection = payConfig && (
    <div className={`flex flex-col gap-3 rounded-2xl border p-3.5 ${charge ? 'border-violet-700 bg-violet-950/30' : 'border-white/10'}`}>
      <ToggleSwitch
        id={`${idPrefix}-charge`}
        label="Charge for access"
        description="Visitors pay you in USDC or USDT on Solana · 90% to you, 10% DropHere fee"
        checked={charge}
        onChange={setCharge}
      />
      {charge && (
        <>
          <label className="flex flex-col gap-1.5 text-xs text-slate-400" htmlFor={`${idPrefix}-price`}>
            Price (USD)
            <input
              id={`${idPrefix}-price`}
              aria-label="Price in USD"
              value={priceText}
              inputMode="decimal"
              onChange={e => setPriceText(e.target.value)}
              className="h-11 w-32 rounded-xl border border-violet-600 bg-slate-950 px-3 font-mono text-base font-bold text-white outline-none focus:ring-2 focus:ring-violet-500/40"
            />
            <span className="text-[11px] text-slate-400">
              {priceOk && split
                ? `You receive ${formatAmount(split.owner)} per sale`
                : `Between ${formatAmount(payConfig.minPrice)} and ${formatAmount(payConfig.maxPrice)}`}
            </span>
          </label>
          {kycOk ? (
            <p className="text-xs text-emerald-300">✓ Signed in with CAFECA{auth.user?.handle ? ` as @${auth.user.handle}` : ''} · ID verified</p>
          ) : (
            <p className="text-xs text-amber-200">
              {auth.user ? 'Your CAFECA account needs ID verification to charge for access. Verify in CAFECA, then ' : 'Sign in with CAFECA (ID verified) to charge for access. '}
              <button type="button" disabled={!auth.enabled || auth.busy} onClick={auth.signIn} className="font-semibold text-blue-300 underline-offset-2 hover:underline disabled:opacity-50">
                {auth.user ? 'sign in again' : 'Sign in'}
              </button>
            </p>
          )}
          <p className="text-[11px] leading-5 text-slate-400">
            After creating, finish in the room’s Plan tab: keep the room at least {PAID_MIN_DAYS} days (from {formatAmount(cheapest.price).replace(/\.00$/, '')} USDC), add the Solana address that receives your payments, then turn sales on. Only you can add files to a paid room.
          </p>
        </>
      )}
    </div>
  );

  const errorLine = error && (
    <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
      {error}
    </p>
  );

  if (variant === 'panel') {
    return (
      <form onSubmit={handleSubmit} className="flex h-full flex-col gap-5" aria-label="Create a room">
        <h2 className="text-lg font-bold text-slate-100">New room</h2>
        {nameField}
        {uploadChoice}
        <div className="flex flex-col">
          {listedSwitch}
          {downloadSwitch}
        </div>
        {passwordField}
        {retention}
        {paidSection}
        {errorLine}
        <button
          type="submit"
          disabled={submitting || paidBlocked}
          className="mt-auto h-12 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Create room'}
        </button>
        <p className="text-center text-[11px] text-slate-500">You become the room owner on this browser, or on your CAFECA account when signed in.</p>
      </form>
    );
  }

  const titles = ['Name your room', 'Who can add files?', 'Privacy and expiry'];
  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col gap-5" aria-label="Create a room">
      <div className="flex items-center justify-between pr-12">
        <span className="text-xs text-slate-400">Step {step} of 3</span>
        <div className="flex gap-1.5" aria-hidden="true">
          {[1, 2, 3].map(n => (
            <span key={n} className={`h-1 w-6 rounded-full ${n <= step ? 'bg-blue-500' : 'bg-slate-700'}`} />
          ))}
        </div>
      </div>
      <h2 className="text-[22px] font-bold text-slate-100">{titles[step - 1]}</h2>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {step === 1 && nameField}
        {step === 2 && (
          <>
            {uploadChoice}
            {downloadSwitch}
          </>
        )}
        {step === 3 && (
          <>
            {listedSwitch}
            {passwordField}
            {retention}
            {paidSection}
          </>
        )}
        {errorLine}
      </div>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={() => (step === 1 ? onCancel?.() : setStep(step - 1))}
          className="h-[50px] flex-1 rounded-2xl border border-white/10 text-[15px] font-semibold text-slate-200"
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        <button
          type="submit"
          disabled={submitting || (step === 3 && paidBlocked)}
          className="h-[50px] flex-[2] rounded-2xl bg-blue-600 text-[15px] font-bold text-white disabled:opacity-60"
        >
          {step < 3 ? 'Next' : submitting ? 'Creating…' : 'Create room'}
        </button>
      </div>
    </form>
  );
}
