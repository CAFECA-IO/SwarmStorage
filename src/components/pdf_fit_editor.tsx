import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { FIT_LEVELS, MB, endsOf, estimateTotal, formatLimit, formatSize, pageRange, partNamesFor, partsFromEnds, planParts, type IPdfAnalysis } from '@/lib/pdf_fit_plan';
import { fetchSample, type IFitSample, type IFitSettings } from '@/lib/pdf_fit_client';
import { LevelPicker, LimitField, blockerOf, startLabel } from '@/components/pdf_fit_dialog';

/**
 * Info: (20261120 - Luphia)
 * PDF 符合大小 B：自訂切點
 * - 上：該頁影像壓縮前後比較 (同一區域、原始解析度)
 * - 下：分段軸，拖曳標記改變每個檔案在哪一頁結束 (可對齊章節起點)；點軸選擇要比較的頁面
 * - 右 (手機在下)：大小上限、壓縮等級、檔案數，建立檔案
 */

type TCompare = 'original' | 'side' | 'compressed';

interface IPdfFitEditorProps {
  roomId: string;
  getToken: () => string | null;
  filename: string;
  analysis: IPdfAnalysis;
  settings: IFitSettings;
  starting: boolean;
  onChange: (settings: IFitSettings) => void;
  onBack: () => void;
  onStart: () => void;
}

const leaf = (filename: string) => filename.split('/').pop() || filename;

// Info: (20261120 - Luphia) 有可壓縮影像的頁面 (含多頁共用的影像)
function imagePagesOf(a: IPdfAnalysis): number[] {
  const set = new Set<number>();
  a.pageImage.forEach((bytes, page) => bytes > 0 && set.add(page));
  a.shared.filter(obj => obj.image).forEach(obj => obj.runs.forEach(([from, to]) => {
    for (let p = from; p <= to; p++) set.add(p);
  }));
  return [...set].sort((x, y) => x - y);
}

export default function PdfFitEditor({ roomId, getToken, filename, analysis, settings, starting, onChange, onBack, onStart }: IPdfFitEditorProps) {
  const imagePages = useMemo(() => imagePagesOf(analysis), [analysis]);
  const [page, setPage] = useState(() => imagePages[0] ?? 0);
  const [pageText, setPageText] = useState(String((imagePages[0] ?? 0) + 1));
  const [compare, setCompare] = useState<TCompare>('side');
  const [sample, setSample] = useState<{ key: string; data: IFitSample | null; error: string | null } | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);

  const limit = settings.limitMb * MB;
  const ends = useMemo(
    () => settings.ends ?? endsOf(planParts(analysis, settings.level, limit, settings.snap)),
    [analysis, limit, settings.ends, settings.level, settings.snap]
  );
  const parts = useMemo(() => partsFromEnds(analysis, settings.level, limit, ends), [analysis, ends, limit, settings.level]);
  const names = partNamesFor(filename, parts.length);
  const blocker = blockerOf(analysis, settings, parts);
  const overCount = parts.filter(p => p.over).length;
  const pages = analysis.pages;

  const sampleKey = `${page}:${settings.level}`;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchSample(roomId, getToken(), filename, page, settings.level)
        .then(data => !cancelled && setSample({ key: sampleKey, data, error: null }))
        .catch(err => !cancelled && setSample({ key: sampleKey, data: null, error: err instanceof Error ? err.message : 'Could not load the preview' }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filename, getToken, page, roomId, sampleKey, settings.level]);
  const current = sample?.key === sampleKey ? sample : null;

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(pages - 1, next));
    setPage(clamped);
    setPageText(String(clamped + 1));
  };
  const prevImagePage = [...imagePages].reverse().find(p => p < page);
  const nextImagePage = imagePages.find(p => p > page);

  const setEnds = (next: number[]) => onChange({ ...settings, ends: [...new Set(next)].sort((a, b) => a - b) });

  // Info: (20261120 - Luphia) 標記 i 移到「在第 boundary 頁之前切開」：限制在相鄰標記之間，開啟對齊時吸附到附近的章節起點
  const moveMarker = (index: number, boundary: number) => {
    const min = index > 0 ? ends[index - 1] + 2 : 1;
    const max = index < ends.length - 1 ? ends[index + 1] : pages - 1;
    let b = Math.max(min, Math.min(max, boundary));
    if (settings.snap && analysis.breaks.length) {
      const tolerance = Math.max(1, Math.round(pages * 0.012));
      const near = analysis.breaks.filter(x => x >= min && x <= max && Math.abs(x - b) <= tolerance).sort((x, y) => Math.abs(x - b) - Math.abs(y - b))[0];
      if (near !== undefined) b = near;
    }
    if (b - 1 === ends[index]) return;
    const next = [...ends];
    next[index] = b - 1;
    setEnds(next);
  };

  const boundaryAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.round(((clientX - rect.left) / rect.width) * pages);
  };

  const onMarkerDown = (index: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = index;
    setSelectedMarker(index);
  };
  const onMarkerMove = (index: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current !== index) return;
    moveMarker(index, boundaryAt(e.clientX));
  };
  const onMarkerUp = () => {
    dragRef.current = null;
  };
  const onMarkerKey = (index: number) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const boundary = ends[index] + 1 + (e.key === 'ArrowLeft' ? -step : step);
      // Info: (20261120 - Luphia) 鍵盤移動不吸附 (才能逐頁微調)
      const min = index > 0 ? ends[index - 1] + 2 : 1;
      const max = index < ends.length - 1 ? ends[index + 1] : pages - 1;
      const next = [...ends];
      next[index] = Math.max(min, Math.min(max, boundary)) - 1;
      setEnds(next);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setEnds(ends.filter((_, i) => i !== index));
      setSelectedMarker(null);
    }
  };

  const canAddHere = page > 0 && !ends.includes(page - 1);
  const pct = (value: number) => `${(value / pages) * 100}%`;
  const compressedTotal = estimateTotal(analysis, settings.level);

  const figure = (kind: 'original' | 'compressed') => {
    const data = current?.data;
    const src = data ? (kind === 'original' ? data.original : data.compressed) : null;
    const caption = !data
      ? kind === 'original'
        ? `Original · page ${page + 1}`
        : `${FIT_LEVELS[settings.level].label} · page ${page + 1}`
      : kind === 'original'
        ? `Original · ${data.originalSize.width} × ${data.originalSize.height} px · ${formatSize(data.originalBytes)}`
        : settings.level === 'none'
          ? 'Not compressed · images unchanged'
          : `${FIT_LEVELS[settings.level].label} · ${data.compressedSize.width} × ${data.compressedSize.height} px · ${formatSize(data.compressedBytes)}`;
    return (
      <figure className="m-0 flex min-w-0 flex-1 flex-col gap-2">
        <figcaption className={`truncate text-xs ${kind === 'compressed' ? 'text-blue-300' : 'text-slate-400'}`}>{caption}</figcaption>
        <div
          className={`relative flex aspect-square max-h-[46vh] items-center justify-center overflow-hidden rounded bg-[#020617] lg:max-h-none ${kind === 'compressed' ? 'outline outline-2 outline-blue-500' : 'outline outline-1 outline-white/10'}`}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={`${kind === 'original' ? 'Original' : 'Compressed'}: detail of page ${page + 1}`} className="h-full w-full object-contain" />
          ) : current ? (
            <p className="max-w-xs p-6 text-center text-[13px] text-slate-400">
              {current.error ?? `No images to compress on page ${page + 1}. Text and drawings stay exactly as they are.`}
            </p>
          ) : (
            <p className="animate-pulse text-[13px] text-slate-400">Loading page {page + 1}…</p>
          )}
        </div>
      </figure>
    );
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
      <main className="flex min-w-0 flex-col lg:overflow-y-auto">
        <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
          <button type="button" onClick={onBack} className="h-10 rounded-[10px] border border-white/10 px-3 text-[13px] text-slate-300 hover:bg-white/5">
            ← Back
          </button>
          <h1 className="min-w-0 flex-1 truncate text-base font-bold text-slate-100">
            {leaf(filename)} <span className="text-[13px] font-normal text-slate-400">· {formatSize(analysis.size)} · {pages} pages</span>
          </h1>
          <div role="group" aria-label="Compare" className="inline-flex gap-[3px] rounded-[10px] border border-white/10 bg-[#0F172A] p-[3px]">
            {(['original', 'side', 'compressed'] as TCompare[]).map(mode => (
              <button
                key={mode}
                type="button"
                aria-pressed={compare === mode}
                onClick={() => setCompare(mode)}
                className={`h-8 rounded-[7px] px-3 text-xs font-semibold ${mode === 'side' ? 'hidden md:block' : ''} ${
                  compare === mode
                    ? 'bg-slate-800 text-white'
                    : mode === 'compressed' && compare === 'side'
                      ? 'bg-slate-800 text-white md:bg-transparent md:text-slate-400'
                      : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {mode === 'original' ? 'Original' : mode === 'side' ? 'Side by side' : 'Compressed'}
              </button>
            ))}
          </div>
        </header>

        <div className="flex flex-col gap-3 bg-[#0B1222] px-4 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <button type="button" disabled={prevImagePage === undefined} onClick={() => prevImagePage !== undefined && goTo(prevImagePage)} className="h-9 rounded-lg border border-white/10 px-2.5 text-slate-300 hover:bg-white/5 disabled:opacity-40">
              ← Image
            </button>
            <label className="flex items-center gap-1.5">
              Page
              <input
                value={pageText}
                inputMode="numeric"
                aria-label="Page to compare"
                onChange={e => {
                  setPageText(e.target.value);
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= pages) setPage(n - 1);
                }}
                className="h-9 w-16 rounded-lg border border-white/10 bg-[#020617] px-2 text-center font-mono text-slate-100"
              />
              of {pages}
            </label>
            <button type="button" disabled={nextImagePage === undefined} onClick={() => nextImagePage !== undefined && goTo(nextImagePage)} className="h-9 rounded-lg border border-white/10 px-2.5 text-slate-300 hover:bg-white/5 disabled:opacity-40">
              Image →
            </button>
            <span className="ml-auto hidden sm:inline">The same area of the largest image on the page, at the original’s full resolution</span>
          </div>
          <div className="flex gap-4">
            {(compare === 'original' || compare === 'side') && <div className={`min-w-0 flex-1 ${compare === 'side' ? 'hidden md:flex' : 'flex'}`}>{figure('original')}</div>}
            {(compare === 'compressed' || compare === 'side') && <div className="flex min-w-0 flex-1">{figure('compressed')}</div>}
          </div>
        </div>

        <section aria-label="Files" className="flex flex-col gap-2.5 border-t border-white/10 px-4 pb-5 pt-3.5 sm:px-6">
          <p className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
            <span>{pages} pages · drag a marker to move where a file ends · tap the bar to preview a page</span>
            {settings.snap && analysis.breaks.length > 0 && <span>Markers snap to chapter starts</span>}
          </p>
          <div
            ref={barRef}
            role="presentation"
            onClick={e => {
              goTo(Math.min(pages - 1, Math.floor(((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.getBoundingClientRect().width) * pages)));
              setSelectedMarker(null);
            }}
            className="relative mt-2 h-16 cursor-pointer select-none"
          >
            {parts.map((part, i) => (
              <div
                key={`${part.from}-${part.to}`}
                className={`absolute top-0 flex h-full flex-col justify-between overflow-hidden border py-1.5 pr-2 ${i === 0 ? 'pl-2' : 'pl-4'} ${part.over ? 'border-red-500 bg-red-950' : 'border-emerald-700 bg-emerald-950'} ${i === 0 ? 'rounded-l-lg' : ''} ${i === parts.length - 1 ? 'rounded-r-lg' : ''}`}
                style={{ left: pct(part.from), width: pct(part.to - part.from + 1) }}
              >
                <span className={`truncate font-mono text-[11px] font-semibold ${part.over ? 'text-red-100' : 'text-emerald-100'}`}>{names[i]}</span>
                <span className={`truncate text-[11px] ${part.over ? 'text-red-300' : 'text-emerald-300'}`}>~{formatSize(part.estimate)}</span>
              </div>
            ))}
            {analysis.breaks.map(b => (
              <span key={b} aria-hidden="true" className="absolute -bottom-2 h-1.5 w-px bg-slate-500" style={{ left: pct(b) }} />
            ))}
            <span aria-hidden="true" className="pointer-events-none absolute -top-1.5 h-[76px] w-0.5 -translate-x-1/2 bg-white/80" style={{ left: pct(page + 0.5) }} />
            {ends.map((end, i) => (
              <button
                key={i}
                type="button"
                aria-label={`File ${i + 1} ends after page ${end + 1}. Arrow keys move it, Delete removes it.`}
                onPointerDown={onMarkerDown(i)}
                onPointerMove={onMarkerMove(i)}
                onPointerUp={onMarkerUp}
                onPointerCancel={onMarkerUp}
                onClick={e => {
                  e.stopPropagation();
                  setSelectedMarker(i);
                }}
                onKeyDown={onMarkerKey(i)}
                onFocus={() => setSelectedMarker(i)}
                className={`absolute -top-2 h-20 w-7 -translate-x-1/2 touch-none rounded-md border-2 lg:w-[22px] ${selectedMarker === i ? 'border-amber-300 bg-blue-500' : 'border-slate-50 bg-blue-600'} cursor-ew-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300`}
                style={{ left: pct(end + 1) }}
              />
            ))}
          </div>
          <div aria-hidden="true" className="relative mt-2 h-4 font-mono text-[10px] text-slate-500">
            <span className="absolute left-0">1</span>
            {ends.map((end, i) => (
              <span key={i} className="absolute -translate-x-1/2" style={{ left: pct(end + 1) }}>
                {end + 2}
              </span>
            ))}
            <span className="absolute right-0">{pages}</span>
          </div>
          <ol className="mt-1 flex flex-wrap gap-1.5 text-xs">
            {parts.map((part, i) => (
              <li key={`${part.from}-${part.to}`} className={`rounded-lg border px-2.5 py-1.5 ${part.over ? 'border-red-500/50 text-red-200' : 'border-white/10 text-slate-300'}`}>
                <span className="font-mono">{names[i]}</span> · {pageRange(part.from, part.to)} · ~{formatSize(part.estimate)}
              </li>
            ))}
          </ol>
        </section>
      </main>

      <aside aria-label="Fit to size" className="flex flex-col gap-[18px] border-t border-white/10 bg-[#0B1222] p-4 sm:p-5 lg:overflow-y-auto lg:border-l lg:border-t-0">
        <h2 className="text-base font-bold text-slate-100">Fit to size</h2>
        <LimitField idPrefix="fit-b" value={settings.limitMb} onChange={limitMb => onChange({ ...settings, limitMb })} />
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-slate-300">Image quality</p>
          <LevelPicker analysis={analysis} name="fit-b-level" value={settings.level} onChange={level => onChange({ ...settings, level })} compact />
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 rounded-xl border border-white/10 p-3.5 text-[13px]">
          <dt className="text-slate-400">Original</dt>
          <dd className="font-mono text-red-300">{formatSize(analysis.size)}</dd>
          <dt className="text-slate-400">After compressing</dt>
          <dd className="font-mono text-blue-300">{settings.level === 'none' ? '—' : `~${formatSize(compressedTotal)}`}</dd>
          <dt className="text-slate-400">Files</dt>
          <dd className={`font-mono font-bold ${overCount ? 'text-red-300' : 'text-emerald-300'}`}>
            {parts.length} × &lt; {formatLimit(settings.limitMb)}
          </dd>
        </dl>
        {analysis.breaks.length > 0 && (
          <label className="flex min-h-10 items-center gap-2.5 text-[13px] text-slate-200">
            <input type="checkbox" aria-label="Snap markers to chapters" checked={settings.snap} onChange={e => onChange({ ...settings, snap: e.target.checked })} className="h-[18px] w-[18px] accent-blue-500" />
            Snap markers to chapters
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canAddHere}
            onClick={() => setEnds([...ends, page - 1])}
            className="h-10 rounded-[10px] border border-white/10 px-3 text-[13px] font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40"
          >
            Split before page {page + 1}
          </button>
          <button
            type="button"
            disabled={selectedMarker === null || selectedMarker >= ends.length}
            onClick={() => {
              if (selectedMarker === null) return;
              setEnds(ends.filter((_, i) => i !== selectedMarker));
              setSelectedMarker(null);
            }}
            className="h-10 rounded-[10px] border border-white/10 px-3 text-[13px] font-semibold text-slate-200 hover:bg-white/5 disabled:opacity-40"
          >
            Remove marker
          </button>
          {settings.ends && (
            <button type="button" onClick={() => onChange({ ...settings, ends: null })} className="h-10 rounded-[10px] px-3 text-[13px] font-semibold text-blue-300 hover:bg-white/5">
              Split automatically
            </button>
          )}
        </div>
        {overCount > 0 && !blocker && (
          <p className="rounded-[10px] border border-amber-500/40 bg-amber-950/30 px-3 py-2.5 text-xs text-amber-200">
            {overCount === 1 ? 'One file looks' : `${overCount} files look`} larger than {formatLimit(settings.limitMb)}. Move a marker or add a split — otherwise it will be split once more when the files are made.
          </p>
        )}
        {blocker && (
          <p role="alert" className="rounded-[10px] border border-red-500/40 bg-red-950/30 px-3 py-2.5 text-[13px] text-red-200">
            {blocker}
          </p>
        )}
        <span className="hidden flex-1 lg:block" />
        <button
          type="button"
          disabled={!!blocker || starting}
          onClick={onStart}
          className="h-12 shrink-0 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {starting ? 'Starting…' : parts.length > 1 ? `Create ${parts.length} files` : startLabel(settings, parts.length)}
        </button>
        <p className="text-[11px] leading-relaxed text-slate-400">Saved to this room in a new folder. The original stays as it is.</p>
      </aside>
    </div>
  );
}
