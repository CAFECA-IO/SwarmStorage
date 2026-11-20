import { FIT_LEVELS, formatLimit, formatSize, pageRange, type IPdfFitJob, type TFitStep } from '@/lib/pdf_fit_plan';
import { FolderIcon, LiveDot } from '@/components/folder_browser';

/**
 * Info: (20261120 - Luphia)
 * PDF 符合大小 C：房間首頁的工作卡片
 * - 進行中：分析 → 壓縮 → 分割 → 存檔，即時進度 (伺服器處理，可以關閉分頁)
 * - 完成：結果資料夾 (每個檔案的頁碼、章節、大小與上限比例)、全部下載
 */

const STEPS: { id: TFitStep; label: string }[] = [
  { id: 'analyze', label: 'Analyze' },
  { id: 'compress', label: 'Compress' },
  { id: 'split', label: 'Split' },
  { id: 'save', label: 'Save' },
];

const leaf = (filename: string) => filename.split('/').pop() || filename;

interface IPdfFitJobCardProps {
  job: IPdfFitJob;
  isMine: boolean;
  canStop: boolean;
  onStop: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  onBrowse: (folder: string) => void;
  onDownloadFolder: (folder: string) => void;
  onOpenFile: (filename: string) => void;
  onDownloadFile: (filename: string) => void;
}

function stepSummary(job: IPdfFitJob, step: TFitStep, state: 'done' | 'active' | 'pending'): string {
  if (state === 'active') return job.detail;
  switch (step) {
    case 'analyze':
      return job.pages ? `${job.pages} pages` : 'Pages, images and chapters';
    case 'compress':
      if (job.level === 'none') return 'Images unchanged';
      return job.compressedSize !== null ? `${formatSize(job.originalSize)} → ${formatSize(job.compressedSize)}` : `Images at ${FIT_LEVELS[job.level].dpi} dpi`;
    case 'split':
      return state === 'done' && job.parts.length ? `${job.parts.length} files` : `Files under ${formatLimit(job.limitMb)}`;
    default:
      return `To this room`;
  }
}

export default function PdfFitJobCard({ job, isMine, canStop, onStop, onDismiss, onRetry, onBrowse, onDownloadFolder, onOpenFile, onDownloadFile }: IPdfFitJobCardProps) {
  const who = isMine ? 'You' : job.startedBy.nickname;
  const name = leaf(job.filename);
  const activeIndex = STEPS.findIndex(s => s.id === job.step);
  const dismissButton = (
    <button type="button" aria-label={`Hide ${name} result`} onClick={onDismiss} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200">
      ×
    </button>
  );

  if (job.status === 'done') {
    const total = job.parts.reduce((sum, p) => sum + p.size, 0);
    const title = job.folder ? leaf(job.folder) : leaf(job.parts[0]?.filename ?? name);
    return (
      <article aria-label={`Result for ${name}`} className="flex flex-col gap-3.5 rounded-2xl border border-white/10 bg-[#0B1222] p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          {job.folder ? (
            <FolderIcon className="h-7 w-7" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-red-950 font-mono text-[10px] font-semibold text-red-300">PDF</span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-bold text-slate-100">{title}</h3>
            <p className="truncate text-xs text-slate-400">
              {who} · {formatSize(total)} total · original {formatSize(job.originalSize)} kept
            </p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            {job.folder ? (
              <>
                <button type="button" onClick={() => onBrowse(job.folder as string)} className="h-10 flex-1 rounded-[10px] border border-white/10 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-white/5 sm:flex-none">
                  Browse folder
                </button>
                <button type="button" onClick={() => onDownloadFolder(job.folder as string)} className="h-10 flex-1 rounded-[10px] bg-blue-600 px-3.5 text-[13px] font-bold text-white hover:bg-blue-500 sm:flex-none">
                  Download all · .zip
                </button>
              </>
            ) : (
              job.parts[0] && (
                <>
                  <button type="button" onClick={() => onOpenFile(job.parts[0].filename)} className="h-10 flex-1 rounded-[10px] border border-white/10 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-white/5 sm:flex-none">
                    Open
                  </button>
                  <button type="button" onClick={() => onDownloadFile(job.parts[0].filename)} className="h-10 flex-1 rounded-[10px] bg-blue-600 px-3.5 text-[13px] font-bold text-white hover:bg-blue-500 sm:flex-none">
                    Download
                  </button>
                </>
              )
            )}
            {dismissButton}
          </div>
        </div>
        <ul className="flex flex-col">
          {job.parts.map(part => {
            const ratio = Math.min(1, part.size / (job.limitMb * 1024 * 1024));
            return (
              <li key={part.filename} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-white/10 py-2.5 text-[13px] md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_80px_minmax(0,1fr)_auto]">
                <button type="button" onClick={() => onOpenFile(part.filename)} className="truncate text-left font-mono font-semibold text-slate-100 hover:text-blue-200">
                  {leaf(part.filename)}
                </button>
                <span className="font-mono text-emerald-300 md:order-3">{formatSize(part.size)}</span>
                <span className="truncate text-xs text-slate-400 md:order-2 md:text-[13px] md:text-slate-300">
                  {pageRange(part.from, part.to)}
                  {part.chapters ? ` · ${part.chapters}` : ''}
                </span>
                <span
                  role="img"
                  aria-label={`${Math.round(ratio * 100)}% of the ${formatLimit(job.limitMb)} limit`}
                  className="col-span-2 block h-1.5 rounded-full bg-slate-800 md:order-4 md:col-span-1 md:h-2"
                >
                  <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${ratio * 100}%` }} />
                </span>
                <button type="button" onClick={() => onDownloadFile(part.filename)} className="hidden text-right text-[13px] text-blue-400 hover:text-blue-300 md:order-5 md:block">
                  Download
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-slate-400">
          Every file was measured after saving and is under {formatLimit(job.limitMb)}. Bookmarks and links within each file are kept.
        </p>
      </article>
    );
  }

  if (job.status === 'failed' || job.status === 'stopped') {
    const failed = job.status === 'failed';
    return (
      <article aria-label={`${name} ${job.status}`} className={`flex flex-wrap items-center gap-3 rounded-2xl border p-4 ${failed ? 'border-red-500/40 bg-red-950/20' : 'border-white/10 bg-[#0B1222]'}`}>
        <div className="min-w-0 flex-1 basis-60">
          <h3 className="truncate text-sm font-semibold text-slate-100">
            {failed ? `Couldn’t fit ${name} into ${formatLimit(job.limitMb)} files` : `Stopped fitting ${name}`}
          </h3>
          <p className={`mt-0.5 text-xs ${failed ? 'text-red-200' : 'text-slate-400'}`}>{failed ? job.error : 'Nothing was saved.'}</p>
        </div>
        <button type="button" onClick={onRetry} className="h-10 rounded-[10px] border border-white/10 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-white/5">
          Change settings
        </button>
        {dismissButton}
      </article>
    );
  }

  return (
    <article aria-label={`Fitting ${name}`} className="flex flex-col gap-4 rounded-2xl border border-blue-900 bg-[#0B1222] p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-red-950 font-mono text-[10px] font-semibold text-red-300">PDF</span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold text-slate-100">
            Fitting {name} into {formatLimit(job.limitMb)} files
          </h3>
          <p className="truncate text-xs text-slate-400">
            {job.status === 'queued' ? `${who} · ${job.detail}` : `Started by ${who.toLowerCase() === 'you' ? 'you' : who} · runs on the server, you can close this tab`}
          </p>
        </div>
        {job.status === 'running' && <LiveDot moving />}
        {canStop && job.step !== 'save' && (
          <button type="button" onClick={onStop} className="h-10 rounded-[10px] border border-white/10 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-white/5">
            {job.status === 'queued' ? 'Cancel' : 'Stop'}
          </button>
        )}
      </div>
      <ol className="grid grid-cols-1 gap-2.5 md:grid-cols-4">
        {STEPS.map((step, i) => {
          const state = job.status === 'queued' ? 'pending' : i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
          const percent = Math.round(job.progress * 100);
          return (
            <li
              key={step.id}
              aria-current={state === 'active' ? 'step' : undefined}
              className={`flex flex-col gap-1.5 rounded-xl border p-3 ${state === 'done' ? 'border-emerald-700 bg-emerald-950/60' : state === 'active' ? 'border-blue-500 bg-[#0B1530]' : 'border-dashed border-slate-700'}`}
            >
              <span className={`text-xs font-bold ${state === 'done' ? 'text-emerald-300' : state === 'active' ? 'text-blue-300' : 'text-slate-400'}`}>
                {state === 'done' ? '✓ ' : ''}
                {step.label}
                {state === 'active' ? ` · ${percent}%` : ''}
              </span>
              {state === 'active' && (
                <span role="progressbar" aria-label={`${step.label} progress`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="block h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <span className="upload-stripes block h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-500" style={{ width: `${Math.max(3, percent)}%` }} />
                </span>
              )}
              <span className={`text-xs ${state === 'done' ? 'text-emerald-100/80' : state === 'active' ? 'text-slate-200' : 'text-slate-500'}`}>{stepSummary(job, step.id, state)}</span>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
