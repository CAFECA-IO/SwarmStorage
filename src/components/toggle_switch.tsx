/**
 * Info: (20261105 - Luphia)
 * 左右滑動的開關 (取代 checkbox)
 * - 使用 <button role="switch">，鍵盤 Space / Enter 皆可切換
 * - 點擊整列文字也能切換
 */

interface IToggleSwitchProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export default function ToggleSwitch({ id, label, description, checked, disabled, onChange }: IToggleSwitchProps) {
  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className="flex items-center justify-between gap-3 min-h-11">
      <label htmlFor={id} id={labelId} className={`flex flex-col gap-0.5 text-[13px] ${disabled ? 'text-slate-500' : 'text-slate-200 cursor-pointer'}`}>
        {label}
        {description && (
          <span id={descriptionId} className="text-[11px] text-slate-400">
            {description}
          </span>
        )}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-11 h-[26px] rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-40 disabled:cursor-not-allowed ${checked ? 'bg-blue-600 border-blue-500' : 'bg-slate-800 border-slate-700'}`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-[3px] left-[3px] w-[18px] h-[18px] rounded-full shadow transition-transform duration-200 ease-out ${checked ? 'translate-x-[18px] bg-white' : 'translate-x-0 bg-slate-400'}`}
        />
      </button>
    </div>
  );
}
