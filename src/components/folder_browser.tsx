import type { ILariaMetadata } from '@/lib/file_operator';
import { formatIdle, formatSpeed, IDLE_AFTER_MS, useUploadMotion, type IUploadMotion } from '@/lib/use_upload_motion';
import type { IUploadStatus } from '@/lib/chat_hub';
import { getExtension, getFileKind } from '@/lib/file_types';
import { formatBytes } from '@/lib/utils';
import { baseName, listChildren, parentOf, type IFolderSummary } from '@/lib/folder_tree';
import FileActionsMenu, { type IFileAction } from '@/components/file_actions_menu';

/**
 * Info: (20261108 - Luphia)
 * 資料夾 (C 方案)：上傳中的上傳包、已完成的資料夾卡片、欄位式瀏覽 (手機為逐層進入)
 */

export function FolderIcon({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="#FBBF24" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

const KIND_DOT: Record<string, string> = {
  html: 'bg-orange-400',
  markdown: 'bg-emerald-400',
  image: 'bg-violet-400',
  video: 'bg-pink-400',
  audio: 'bg-teal-400',
  pdf: 'bg-red-400',
  text: 'bg-sky-400',
  other: 'bg-slate-400',
};

// Info: (20261110 - Luphia) 進度以送出的位元組計算 (分片存好前也會前進)；舊版回報沒有位元組時改用分片數
export const uploadFraction = (upload: IUploadStatus): number => {
  if (typeof upload.bytesDone === 'number' && upload.size > 0) return Math.min(1, upload.bytesDone / upload.size);
  return upload.shardsTotal ? upload.shardsDone / upload.shardsTotal : 0;
};
export const percentOf = (upload: IUploadStatus) => Math.floor(uploadFraction(upload) * 100);

export const etaOf = (upload: IUploadStatus): string | null => {
  const elapsed = upload.updatedAt - upload.startedAt;
  const fraction = uploadFraction(upload);
  if (fraction <= 0.01 || fraction >= 1 || elapsed <= 0) return null;
  const remaining = ((1 - fraction) * elapsed) / fraction / 1000;
  return remaining < 60 ? `~${Math.max(1, Math.round(remaining))} s left` : `~${Math.round(remaining / 60)} min left`;
};

// Info: (20261110 - Luphia) 正在動的上傳：閃爍的小圓點 + 速度；超過 10 秒沒有新進度則顯示多久沒有新資料
export function LiveDot({ moving }: { moving: boolean }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
      {moving && <span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 motion-safe:animate-ping" />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${moving ? 'bg-blue-400' : 'bg-slate-600'}`} />
    </span>
  );
}

export const motionText = (motion: IUploadMotion, uploading: boolean): string | null => {
  if (!uploading) return null;
  if (motion.moving) return motion.speed ? formatSpeed(motion.speed) : null;
  return motion.idleSeconds * 1000 >= IDLE_AFTER_MS ? `no new data for ${formatIdle(motion.idleSeconds)}` : null;
};

export interface IUploadControl {
  busy: boolean;
  // Info: (20261110 - Luphia) 暫停原因 (null 表示進行中)
  paused: string | null;
  onCancel: () => void;
  onResume: () => void;
}

// Info: (20261108 - Luphia) 取消 / 續傳 (只在執行上傳的分頁顯示)
export function UploadControls({ name, busy, paused, onCancel, onResume }: IUploadControl & { name: string }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      {paused !== null && !busy && (
        <button
          type="button"
          onClick={onResume}
          aria-label={`Resume upload of ${name}`}
          className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-500"
        >
          Resume
        </button>
      )}
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label={`Cancel upload of ${name}`}
        className="h-8 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-200 disabled:cursor-default disabled:opacity-60 disabled:hover:border-white/10 disabled:hover:bg-transparent disabled:hover:text-slate-200"
      >
        {busy ? 'Cancelling…' : 'Cancel'}
      </button>
    </span>
  );
}

export function BundleUploadCard({
  upload,
  isMine,
  watching,
  onToggleWatch,
  control,
}: {
  upload: IUploadStatus;
  isMine: boolean;
  watching: boolean;
  onToggleWatch: () => void;
  control: IUploadControl | null;
}) {
  const percent = percentOf(upload);
  const interrupted = upload.status === 'interrupted' || (control?.paused ?? null) !== null;
  const who = isMine ? 'You' : upload.uploader.nickname;
  const bytesDone = upload.size * uploadFraction(upload);
  const note = control?.paused ?? upload.note;
  const motion = useUploadMotion(upload, (control?.paused ?? null) !== null);
  const live = motionText(motion, !interrupted);
  // Info: (20261110 - Luphia) 沒有在動時不顯示剩餘時間 (會誤導)
  const eta = interrupted || !motion.moving ? null : etaOf(upload);

  return (
    <article
      aria-label={`Uploading folder ${upload.filename}`}
      className={`flex flex-col gap-3 rounded-2xl border p-4 ${interrupted ? 'border-amber-500/40 bg-[#0B1222]' : 'border-blue-900 bg-[#0B1530]'}`}
    >
      <div className="flex items-center gap-3">
        <FolderIcon />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold text-slate-100">{upload.filename}</h3>
          <p className={`text-xs ${interrupted ? 'text-amber-300' : 'text-blue-300'}`}>
            {who} · {upload.filesDone ?? 0} of {upload.filesTotal ?? 0} files · {formatBytes(bytesDone)} of {formatBytes(upload.size)}
            {interrupted ? (upload.paused || control?.paused ? ' · paused' : ' · interrupted') : eta ? ` · ${eta}` : ''}
          </p>
          {live && (
            <p className={`mt-0.5 text-xs ${motion.moving ? 'text-blue-200' : 'text-slate-400'}`} aria-live="off">
              {live}
            </p>
          )}
          {note && <p className="mt-0.5 text-xs text-amber-300">{note}</p>}
        </div>
        {!interrupted && <LiveDot moving={motion.moving} />}
        <span className="font-mono text-xl font-bold text-blue-300">{percent}%</span>
      </div>
      <div
        className={`h-1.5 overflow-hidden rounded-full bg-slate-800 ${motion.moving && percent < 2 ? 'upload-stripes' : ''}`}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${upload.filename} upload progress`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${interrupted ? 'bg-amber-400' : 'bg-blue-500'} ${motion.moving ? 'upload-stripes' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {upload.parts && upload.parts.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-xs">
          {upload.parts.map(part => (
            <div key={part.name} className="contents">
              <dt className="truncate text-slate-300">{part.name}</dt>
              <dd className={`font-mono ${part.done === part.total ? 'text-emerald-300' : 'text-blue-300'}`}>
                {part.done} / {part.total}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {control && (
        <div className="flex justify-end">
          <UploadControls name={upload.filename} {...control} />
        </div>
      )}
      {!isMine && (
        <button
          type="button"
          onClick={onToggleWatch}
          aria-pressed={watching}
          className={`self-start rounded-lg px-3 py-1.5 text-xs font-semibold ${watching ? 'bg-blue-600 text-white' : 'border border-white/10 text-slate-300 hover:bg-white/5'}`}
        >
          {watching ? 'Will notify' : 'Notify me'}
        </button>
      )}
    </article>
  );
}

export function FolderCard({
  folder,
  uploaderLabel,
  isNew,
  isMine,
  actions,
  onBrowse,
  onDownload,
  preview,
}: {
  folder: IFolderSummary;
  uploaderLabel: string;
  isNew: boolean;
  isMine: boolean;
  actions: IFileAction[];
  onBrowse: () => void;
  onDownload: () => void;
  preview: string;
}) {
  return (
    <article className={`flex flex-col gap-3 rounded-2xl border bg-[#0B1222] p-4 ${isMine ? 'border-blue-800' : isNew ? 'border-emerald-700' : 'border-white/10'}`}>
      <div className="flex items-center gap-3">
        <FolderIcon />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold text-slate-100">{folder.name}</h3>
          <p className={`text-xs ${isNew ? 'text-emerald-300' : isMine ? 'text-blue-300' : 'text-slate-400'}`}>
            {isNew ? 'Ready · ' : ''}
            {uploaderLabel} · {folder.count} {folder.count === 1 ? 'file' : 'files'} · {formatBytes(folder.size)}
          </p>
        </div>
        <FileActionsMenu filename={folder.name} actions={actions} highlighted={isMine} />
      </div>
      {preview && <p className="truncate text-xs text-slate-400">{preview}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onBrowse} className="h-9 rounded-lg bg-slate-800 px-3.5 text-xs font-semibold text-white hover:bg-slate-700">
          Browse
        </button>
        <button type="button" onClick={onDownload} className="h-9 rounded-lg border border-white/10 px-3.5 text-xs font-semibold text-slate-200 hover:bg-white/5">
          Download all · .zip
        </button>
      </div>
    </article>
  );
}

interface IColumnBrowserProps {
  files: ILariaMetadata[];
  // Info: (20261108 - Luphia) 目前瀏覽的資料夾 (完整路徑)
  path: string;
  selected: string | null;
  uploading: Set<string>;
  canDownloadFile: (file: ILariaMetadata) => boolean;
  uploaderLabel: (file: ILariaMetadata) => string;
  onNavigate: (path: string, selected: string | null) => void;
  onOpenFile: (filename: string) => void;
  onDownloadFile: (filename: string) => void;
  onDownloadFolder: (path: string) => void;
  onClose: () => void;
}

/**
 * Info: (20261108 - Luphia)
 * 欄位式瀏覽：從上傳包根資料夾到目前資料夾，每一層一欄，最右側為選取檔案的資訊
 * 手機只顯示目前這一層 (逐層進入，返回鍵回上一層)
 */
export function ColumnBrowser({
  files,
  path,
  selected,
  uploading,
  canDownloadFile,
  uploaderLabel,
  onNavigate,
  onOpenFile,
  onDownloadFile,
  onDownloadFolder,
  onClose,
}: IColumnBrowserProps) {
  const segments = path.split('/');
  const levels = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  const selectedFile = selected ? files.find(f => f.filename === selected) ?? null : null;
  const pendingHere = [...uploading].filter(name => parentOf(name) === path);

  return (
    <section aria-label={`Browsing ${path}`} className="overflow-hidden rounded-2xl border border-white/10">
      <div className="flex flex-wrap items-center gap-2 bg-[#0D1424] px-3 py-2.5 sm:px-4">
        {levels.length > 1 && (
          <button
            type="button"
            aria-label="Up one folder"
            onClick={() => onNavigate(parentOf(path), null)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-lg text-slate-300 hover:bg-white/10 md:hidden"
          >
            ‹
          </button>
        )}
        <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[13px]">
          {levels.map((level, i) => (
            <span key={level} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true" className="text-slate-600">/</span>}
              {i === levels.length - 1 ? (
                <span aria-current="page" className="font-semibold text-slate-100">
                  {baseName(level)}
                </span>
              ) : (
                <button type="button" onClick={() => onNavigate(level, null)} className="text-slate-400 hover:text-slate-200">
                  {baseName(level)}
                </button>
              )}
            </span>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => onDownloadFolder(path)}
          className="h-9 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-200 hover:bg-white/5"
        >
          Download “{baseName(path)}” · .zip
        </button>
        <button type="button" onClick={onClose} aria-label="Close folder" className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10">
          ×
        </button>
      </div>

      <div className="flex min-h-[320px] overflow-x-auto">
        {levels.map((level, depth) => {
          const isCurrent = depth === levels.length - 1;
          const children = listChildren(files, level);
          const activeChild = isCurrent ? selected : levels[depth + 1];
          const empty = children.folders.length === 0 && children.files.length === 0;
          return (
            <ul
              key={level}
              aria-label={baseName(level)}
              className={`w-full shrink-0 flex-col gap-0.5 border-white/10 p-2 md:flex md:w-64 md:border-r ${isCurrent ? 'flex' : 'hidden'}`}
            >
              {children.folders.map(folder => {
                const active = activeChild === folder.path;
                return (
                  <li key={folder.path}>
                    <button
                      type="button"
                      onClick={() => onNavigate(folder.path, null)}
                      aria-current={active ? 'true' : undefined}
                      className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${active ? 'bg-blue-900 text-white' : 'text-slate-200 hover:bg-white/5'}`}
                    >
                      <FolderIcon className="h-4 w-4" />
                      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                      <span className="font-mono text-[10px] text-slate-400">{folder.count}</span>
                      <span aria-hidden="true" className="text-slate-500">
                        ›
                      </span>
                    </button>
                  </li>
                );
              })}
              {children.files.map(file => {
                const active = activeChild === file.filename;
                const kind = getFileKind(file.filename, file.mimeType);
                return (
                  <li key={file.filename}>
                    <button
                      type="button"
                      onClick={() => onNavigate(level, file.filename)}
                      onDoubleClick={() => onOpenFile(file.filename)}
                      aria-current={active ? 'true' : undefined}
                      className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${active ? 'bg-slate-800 text-white' : 'text-slate-200 hover:bg-white/5'}`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-sm ${KIND_DOT[kind] ?? KIND_DOT.other}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{baseName(file.filename)}</span>
                      {!canDownloadFile(file) && <span className="text-[10px] text-amber-300">view only</span>}
                      <span className="font-mono text-[10px] text-slate-400">{formatBytes(file.originalFileSize)}</span>
                    </button>
                  </li>
                );
              })}
              {isCurrent &&
                pendingHere.map(name => (
                  <li key={name} className="flex min-h-10 items-center gap-2.5 px-2.5 text-[13px] italic text-slate-400">
                    <span className="h-2 w-2 shrink-0 rounded-sm border border-dashed border-slate-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{baseName(name)}</span>
                    <span className="text-[10px] not-italic text-blue-300">uploading</span>
                  </li>
                ))}
              {empty && pendingHere.length === 0 && <li className="px-2.5 py-3 text-xs text-slate-500">This folder is empty.</li>}
            </ul>
          );
        })}

        {selectedFile && (
          <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2.5 rounded-t-2xl border-t border-white/10 bg-slate-900 p-4 md:static md:w-72 md:shrink-0 md:rounded-none md:border-0 md:bg-transparent">
            <div className="flex h-24 items-center justify-center rounded-xl bg-slate-800 font-mono text-sm font-bold text-slate-300 uppercase">
              {(getExtension(selectedFile.filename) || 'file').slice(0, 4)}
            </div>
            <p className="break-all text-sm font-semibold text-slate-100">{baseName(selectedFile.filename)}</p>
            <p className="break-all text-xs text-slate-400">
              {parentOf(selectedFile.filename)} · {formatBytes(selectedFile.originalFileSize)} · {uploaderLabel(selectedFile)}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => onOpenFile(selectedFile.filename)} className="h-10 flex-1 rounded-lg bg-blue-600 text-xs font-semibold text-white hover:bg-blue-500">
                Open
              </button>
              {canDownloadFile(selectedFile) ? (
                <button
                  type="button"
                  onClick={() => onDownloadFile(selectedFile.filename)}
                  className="h-10 flex-1 rounded-lg border border-white/10 text-xs font-semibold text-slate-200 hover:bg-white/5"
                >
                  Download
                </button>
              ) : (
                <span className="flex h-10 flex-1 items-center justify-center rounded-lg border border-white/10 text-xs text-amber-300">View only</span>
              )}
            </div>
            <button type="button" onClick={() => onNavigate(path, null)} className="text-xs text-slate-400 hover:text-slate-200 md:hidden">
              Close
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
