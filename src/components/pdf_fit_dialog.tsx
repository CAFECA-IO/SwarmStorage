import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FIT_LEVELS,
  FIT_LEVEL_ORDER,
  LIMIT_PRESETS,
  MAX_LIMIT_MB,
  MB,
  MIN_LIMIT_MB,
  compressedNameFor,
  estimateTotal,
  formatLimit,
  formatSize,
  pageRange,
  partNamesFor,
  partsFolderFor,
  partsFromEnds,
  planParts,
  type IPartPlan,
  type IPdfAnalysis,
  type TFitLevel,
} from '@/lib/pdf_fit_plan';
import type { IFitSettings } from '@/lib/pdf_fit_client';

/**
 * Info: (20261120 - Luphia)
 * PDF 符合大小 A：從檔案選單開啟的規劃對話框
 * 輸入大小上限 → 選壓縮等級 (各等級估計大小) → 預覽切成幾個檔案；需要時進入 B 自訂切點
 */

const leaf = (filename: string) => filename.split('/').pop() || filename;

export const defaultFitSettings = (analysis: IPdfAnalysis | null): IFitSettings => ({
  limitMb: 15,
  level: analysis && analysis.images.processable === 0 ? 'none' : 'balanced',
  snap: true,
  ends: null,
});

// Info: (20261120 - Luphia) 依設定計算各段 (自訂切點或自動切段)
export function partsFor(analysis: IPdfAnalysis, settings: IFitSettings): IPartPlan[] {
  const limit = settings.limitMb * MB;
  return settings.ends ? partsFromEnds(analysis, settings.level, limit, settings.ends) : planParts(analysis, settings.level, limit, settings.snap);
}

// Info: (20261120 - Luphia) 無法開始的原因 (null 表示可以開始)
export function blockerOf(analysis: IPdfAnalysis, settings: IFitSettings, parts: IPartPlan[]): string | null {
  if (!(settings.limitMb >= MIN_LIMIT_MB && settings.limitMb <= MAX_LIMIT_MB)) return `Choose a size between ${MIN_LIMIT_MB} and ${MAX_LIMIT_MB} MB.`;
  if (settings.level === 'none' && analysis.size <= settings.limitMb * MB) return `${leaf(analysis.filename)} is already under ${formatLimit(settings.limitMb)}.`;
  const single = parts.find(p => p.over && p.from === p.to);
  if (single) {
    return `Page ${single.from + 1} alone is about ${formatSize(single.estimate)}${settings.level === 'none' ? '' : ' at this level'}. Choose ${settings.level === 'strong' ? 'a larger size' : 'stronger compression or a larger size'}.`;
  }
  return null;
}

export const startLabel = (settings: IFitSettings, count: number) =>
  count > 1 ? (settings.level === 'none' ? `Split into ${count} files` : 'Compress and split') : 'Compress';

export function LimitField({ value, onChange, idPrefix }: { value: number; onChange: (mb: number) => void; idPrefix: string }) {
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  // Info: (20261120 - Luphia) 外部改變上限 (例如按常用大小) 時同步輸入框
  if (synced !== value) {
    setSynced(value);
    setText(String(value));
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={`${idPrefix}-limit`} className="flex flex-col gap-1.5 text-xs font-semibold text-slate-300">
        Each file must be under
        <span className="flex items-center gap-2">
          <input
            id={`${idPrefix}-limit`}
            aria-label="Largest file size in MB"
            value={text}
            inputMode="decimal"
            onChange={e => {
              setText(e.target.value);
              const mb = Number(e.target.value);
              if (Number.isFinite(mb) && mb > 0) {
                setSynced(mb);
                onChange(mb);
              }
            }}
            className="h-11 w-24 rounded-[10px] border border-blue-500 bg-[#020617] px-3 font-mono text-xl font-bold text-white focus:outline-none focus:ring-2 focus:ring-blue-500/60"
          />
          <span className="text-[15px] text-slate-200">MB</span>
        </span>
      </label>
      <div role="group" aria-label="Common limits" className="flex flex-wrap gap-1.5">
        {LIMIT_PRESETS.map(preset => (
          <button
            key={preset.mb}
            type="button"
            aria-pressed={value === preset.mb}
            onClick={() => onChange(preset.mb)}
            className={`h-9 rounded-full border px-3 text-xs font-semibold ${value === preset.mb ? 'border-blue-500 bg-[#0B1530] text-white' : 'border-white/10 text-slate-300 hover:bg-white/5'}`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LevelPicker({
  analysis,
  value,
  onChange,
  name,
  compact = false,
}: {
  analysis: IPdfAnalysis;
  value: TFitLevel;
  onChange: (level: TFitLevel) => void;
  name: string;
  compact?: boolean;
}) {
  const levels = FIT_LEVEL_ORDER;
  return (
    <div role="radiogroup" aria-label="Compression" className={compact ? 'grid grid-cols-2 gap-1.5' : 'flex flex-col gap-2'}>
      {levels.map(level => {
        const active = value === level;
        const estimate = estimateTotal(analysis, level);
        const disabled = level !== 'none' && analysis.images.processable === 0;
        return (
          <label
            key={level}
            className={`flex cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] ${active ? 'border-blue-500 bg-[#0B1530]' : 'border-white/10 hover:bg-white/5'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <input type="radio" aria-label={FIT_LEVELS[level].label} name={name} checked={active} disabled={disabled} onChange={() => onChange(level)} className="accent-blue-500" />
            <span className="min-w-0 flex-1">
              <span className={active ? 'font-semibold text-white' : 'text-slate-200'}>
                {FIT_LEVELS[level].label}
                {level === 'balanced' && !compact ? ' · recommended' : ''}
              </span>
              {compact ? (
                <span className={`block font-mono text-[11px] ${active ? 'text-blue-200' : 'text-slate-400'}`}>{level === 'none' ? formatSize(estimate) : `~${formatSize(estimate)}`}</span>
              ) : (
                <span className={`block text-[11px] ${active ? 'text-blue-200' : 'text-slate-400'}`}>{FIT_LEVELS[level].hint}</span>
              )}
            </span>
            {!compact && <span className={`font-mono text-xs ${active ? 'font-bold text-white' : 'text-slate-300'}`}>{level === 'none' ? formatSize(estimate) : `~${formatSize(estimate)}`}</span>}
          </label>
        );
      })}
    </div>
  );
}

// Info: (20261120 - Luphia) 流程示意：原檔 → 壓縮後 → N 個檔案
export function FitPipeline({ analysis, settings, parts }: { analysis: IPdfAnalysis; settings: IFitSettings; parts: IPartPlan[] }) {
  const compressed = estimateTotal(analysis, settings.level);
  const shown = Math.min(parts.length, 8);
  return (
    <figure
      aria-label={`${formatSize(analysis.size)}, ${settings.level === 'none' ? 'not compressed' : `compressed to about ${formatSize(compressed)}`}, ${parts.length} ${parts.length === 1 ? 'file' : 'files'}`}
      className="m-0 grid grid-cols-[1fr_20px_0.62fr_20px_0.9fr] items-center gap-1.5 rounded-[14px] border border-white/10 bg-[#0B1222] p-3 sm:grid-cols-[1fr_34px_0.62fr_34px_0.9fr] sm:gap-2 sm:p-3.5"
    >
      <div>
        <div className="h-8 rounded-lg bg-red-900 sm:h-11" />
        <p className="mt-1.5 text-[11px] text-red-300 sm:text-xs">Original · {formatSize(analysis.size)}</p>
      </div>
      <span aria-hidden="true" className="text-center text-slate-500">→</span>
      <div>
        <div className="h-8 rounded-lg bg-blue-700 sm:h-11" />
        <p className="mt-1.5 text-[11px] text-blue-300 sm:text-xs">{settings.level === 'none' ? 'Not compressed' : `Compressed · ~${formatSize(compressed)}`}</p>
      </div>
      <span aria-hidden="true" className="text-center text-slate-500">→</span>
      <div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${shown}, minmax(0, 1fr))` }}>
          {Array.from({ length: shown }, (_, i) => (
            <span key={i} className={`h-8 rounded-lg sm:h-11 ${parts[i]?.over ? 'bg-red-700' : 'bg-emerald-700'}`} />
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-emerald-300 sm:text-xs">
          {parts.length} {parts.length === 1 ? 'file' : 'files'} · each &lt; {formatLimit(settings.limitMb)}
        </p>
      </div>
    </figure>
  );
}

interface IPdfFitDialogProps {
  filename: string;
  analysis: IPdfAnalysis | null;
  loadError: string | null;
  settings: IFitSettings;
  starting: boolean;
  onChange: (settings: IFitSettings) => void;
  onCustomize: () => void;
  onStart: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export default function PdfFitDialog({ filename, analysis, loadError, settings, starting, onChange, onCustomize, onStart, onRetry, onClose }: IPdfFitDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const parts = useMemo(() => (analysis ? partsFor(analysis, settings) : []), [analysis, settings]);
  const blocker = analysis ? blockerOf(analysis, settings, parts) : null;
  const names = parts.length > 1 ? partNamesFor(filename, parts.length) : [leaf(compressedNameFor(filename))];
  const shownParts = parts.length > 6 ? parts.slice(0, 5) : parts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [analysis]);

  return (
    <div className="fixed inset-x-0 top-viewport z-50 h-viewport">
      <div aria-hidden="true" className="absolute inset-0 bg-[#020617]/75" onClick={onClose} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-fit-title"
        className="absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col gap-4 overflow-y-auto rounded-t-[20px] border-t border-white/10 bg-[#0F172A] px-4 pb-5 pt-2.5 shadow-2xl shadow-black/60 sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-12 sm:max-h-[calc(100vh-6rem)] sm:w-[min(760px,calc(100%-32px))] sm:-translate-x-1/2 sm:gap-[18px] sm:rounded-[18px] sm:border sm:p-6"
      >
        <span aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-slate-700 sm:hidden" />
        <div>
          <h2 id="pdf-fit-title" className="text-[17px] font-bold text-slate-100 sm:text-[19px]">
            Make “{leaf(filename)}” fit a size limit
          </h2>
          <p className="mt-1.5 text-xs text-slate-400 sm:text-[13px]">
            {analysis
              ? `${formatSize(analysis.size)} · ${analysis.pages} pages · ${analysis.images.count} ${analysis.images.count === 1 ? 'image' : 'images'}. Compress first; whatever is still too big is split into parts.`
              : 'Compress first; whatever is still too big is split into parts.'}
          </p>
        </div>

        {!analysis ? (
          loadError ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-red-500/30 bg-red-950/30 p-4 text-sm text-red-200">
              {loadError}
              <div className="flex gap-2">
                <button type="button" onClick={onRetry} className="h-10 rounded-xl border border-white/10 px-4 text-[13px] font-semibold text-slate-100 hover:bg-white/5">
                  Try again
                </button>
                <button type="button" onClick={onClose} className="h-10 rounded-xl px-4 text-[13px] font-semibold text-slate-300 hover:bg-white/5">
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div role="status" className="flex flex-col gap-3 rounded-[14px] border border-white/10 bg-[#0B1222] p-5">
              <p className="text-sm text-slate-200">Measuring {leaf(filename)}…</p>
              <p className="text-xs text-slate-400">Reading the file from storage and test-compressing a few images to estimate sizes.</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div className="upload-stripes h-full w-full bg-blue-700" />
              </div>
            </div>
          )
        ) : (
          <>
            <LimitField idPrefix="fit-a" value={settings.limitMb} onChange={limitMb => onChange({ ...settings, limitMb })} />
            <FitPipeline analysis={analysis} settings={settings} parts={parts} />

            <div className="grid grid-cols-1 gap-[18px] md:grid-cols-2">
              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                <legend className="mb-2 p-0 text-[13px] font-bold text-slate-100">1 · Compress</legend>
                <LevelPicker analysis={analysis} name="fit-a-level" value={settings.level} onChange={level => onChange({ ...settings, level })} />
                {analysis.images.processable === 0 && <p className="text-[11px] text-slate-400">No images that can be compressed — this PDF can only be split.</p>}
              </fieldset>
              <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                <legend className="mb-2 p-0 text-[13px] font-bold text-slate-100">
                  2 · {parts.length > 1 ? `Split into ${parts.length} files` : 'No split needed'}
                </legend>
                <ol className="flex flex-col gap-1.5">
                  {shownParts.map((part, i) => (
                    <li
                      key={`${part.from}-${part.to}`}
                      className={`flex items-center gap-2.5 rounded-[10px] border bg-[#0B1222] px-3 py-2 text-[13px] ${part.over ? 'border-red-500/50' : 'border-white/10'}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono font-semibold text-slate-100">{names[i]}</span>
                      <span className="shrink-0 text-xs text-slate-400">{pageRange(part.from, part.to)}</span>
                      <span className={`shrink-0 font-mono text-xs ${part.over ? 'text-red-300' : 'text-emerald-300'}`}>~{formatSize(part.estimate)}</span>
                    </li>
                  ))}
                  {parts.length > shownParts.length && <li className="px-3 text-xs text-slate-400">+ {parts.length - shownParts.length} more files</li>}
                </ol>
                {analysis.breaks.length > 0 && !settings.ends && parts.length > 1 && (
                  <label className="flex min-h-10 items-center gap-2.5 text-[13px] text-slate-200">
                    <input type="checkbox" aria-label="Split only between chapters" checked={settings.snap} onChange={e => onChange({ ...settings, snap: e.target.checked })} className="h-[18px] w-[18px] accent-blue-500" />
                    Split only between chapters (from bookmarks)
                  </label>
                )}
                {settings.ends && (
                  <p className="text-xs text-blue-200">
                    Using your split points ·{' '}
                    <button type="button" onClick={() => onChange({ ...settings, ends: null })} className="underline hover:text-white">
                      split automatically
                    </button>
                  </p>
                )}
                {parts.length > 1 && (
                  <button type="button" onClick={onCustomize} className="self-start text-[13px] font-semibold text-blue-300 underline-offset-2 hover:text-blue-200 hover:underline">
                    Adjust split points…
                  </button>
                )}
              </fieldset>
            </div>

            <p className="rounded-[10px] border border-white/10 bg-[#0B1222] px-3 py-2.5 text-xs leading-relaxed text-slate-400">
              {analysis.sampled > 0 ? `Sizes are estimated from ${analysis.sampled} sample ${analysis.sampled === 1 ? 'image' : 'images'}. ` : 'Sizes are estimated. '}
              After compressing, every file is measured again; one that is still over {formatLimit(settings.limitMb)} is split once more, so no file is over the limit.
            </p>
            {blocker && (
              <p role="alert" className="rounded-[10px] border border-red-500/40 bg-red-950/30 px-3 py-2.5 text-[13px] text-red-200">
                {blocker}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 basis-64 text-xs text-slate-400 sm:text-[13px]">
                {parts.length > 1 ? (
                  <>
                    Saved to this room in a folder “{leaf(partsFolderFor(filename, settings.limitMb))}”. The original stays as it is.
                  </>
                ) : (
                  <>Saved next to the original as “{names[0]}”.</>
                )}
              </p>
              <div className="flex w-full gap-2 sm:w-auto">
                <button type="button" onClick={onClose} className="h-11 flex-1 rounded-xl border border-white/10 px-[18px] text-sm font-semibold text-slate-200 hover:bg-white/5 sm:flex-none">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!!blocker || starting}
                  onClick={onStart}
                  className="h-11 flex-[2] rounded-xl bg-blue-600 px-[18px] text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
                >
                  {starting ? 'Starting…' : startLabel(settings, parts.length)}
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
