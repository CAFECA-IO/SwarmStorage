import type { ILariaMetadata } from '@/lib/file_operator';
import type { IUploadStatus } from '@/lib/chat_hub';
import { getExtension, getFileKind, type TFileKind } from '@/lib/file_types';
import { formatBytes } from '@/lib/utils';

const SHARDS_PER_STRIPE = 8;
const DATA_SHARDS = 5;
// Info: (20261105 - Luphia) 分片數不多時逐格顯示，否則改為進度條
const MAX_SHARD_CELLS = 48;
// Info: (20261105 - Luphia) 進房後新增的檔案在 10 分鐘內標示為新檔案
const NEW_FILE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_FILES = 12;

const KIND_TILE: Record<TFileKind, string> = {
  html: 'bg-orange-950 text-orange-300',
  markdown: 'bg-emerald-950 text-emerald-300',
  image: 'bg-violet-950 text-violet-300',
  video: 'bg-pink-950 text-pink-300',
  audio: 'bg-teal-950 text-teal-300',
  pdf: 'bg-red-950 text-red-300',
  text: 'bg-sky-950 text-sky-300',
  other: 'bg-slate-800 text-slate-300',
};

export const formatRelative = (timestamp: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
};

const formatEta = (upload: IUploadStatus): string | null => {
  const elapsed = upload.updatedAt - upload.startedAt;
  if (upload.shardsDone === 0 || elapsed <= 0) return null;
  const remaining = ((upload.shardsTotal - upload.shardsDone) * elapsed) / upload.shardsDone / 1000;
  if (remaining < 60) return `~${Math.max(1, Math.round(remaining))} s left`;
  return `~${Math.round(remaining / 60)} min left`;
};

function TypeTile({ filename, kind, className = 'h-10 w-10 text-[10px]' }: { filename: string; kind: TFileKind; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-[10px] font-mono font-semibold uppercase ${KIND_TILE[kind]} ${className}`}>
      {(getExtension(filename) || 'file').slice(0, 4)}
    </span>
  );
}

function UploadCard({
  upload,
  isMine,
  watching,
  onToggleWatch,
}: {
  upload: IUploadStatus;
  isMine: boolean;
  watching: boolean;
  onToggleWatch: () => void;
}) {
  const kind = getFileKind(upload.filename, upload.mimeType);
  const percent = upload.shardsTotal ? Math.floor((upload.shardsDone / upload.shardsTotal) * 100) : 0;
  const stripes = Math.ceil(upload.shardsTotal / SHARDS_PER_STRIPE);
  const currentStripe = Math.min(stripes, Math.floor(upload.shardsDone / SHARDS_PER_STRIPE) + 1);
  const bytesDone = upload.shardsTotal ? (upload.size * upload.shardsDone) / upload.shardsTotal : 0;
  const interrupted = upload.status === 'interrupted';
  const eta = interrupted ? null : formatEta(upload);
  const who = isMine ? 'You' : upload.uploader.nickname;

  return (
    <article className={`flex flex-col gap-3 rounded-2xl border bg-[#0B1222] p-4 ${interrupted ? 'border-amber-500/40' : 'border-white/10'}`}>
      <div className="flex items-center gap-3">
        <TypeTile filename={upload.filename} kind={kind} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-slate-100">{upload.filename}</h3>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {who} · {formatBytes(Math.round(bytesDone))} / {formatBytes(upload.size)}
            {eta ? ` · ${eta}` : ''}
          </p>
        </div>
        <span className="font-mono text-xl text-slate-100">{percent}%</span>
      </div>

      {upload.shardsTotal > 0 && upload.shardsTotal <= MAX_SHARD_CELLS ? (
        <div
          className="grid gap-[2px]"
          style={{ gridTemplateColumns: `repeat(${Math.min(upload.shardsTotal, 24)}, minmax(0, 1fr))` }}
          role="img"
          aria-label={`${upload.shardsDone} of ${upload.shardsTotal} shards stored`}
        >
          {Array.from({ length: upload.shardsTotal }, (_, i) => (
            <span
              key={i}
              className={`h-[18px] rounded-sm ${i < upload.shardsDone ? (i % SHARDS_PER_STRIPE < DATA_SHARDS ? 'bg-blue-600' : 'bg-amber-600') : 'bg-slate-800'}`}
            />
          ))}
        </div>
      ) : (
        <div
          className="h-[18px] overflow-hidden rounded bg-slate-800"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${upload.filename} upload progress`}
        >
          <div className="h-full bg-blue-600 transition-all duration-500" style={{ width: `${percent}%` }} />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
        {interrupted ? (
          <span className="text-amber-300">Interrupted · waiting for {who === 'You' ? 'you' : who}</span>
        ) : (
          <span>
            {upload.shardsDone} of {upload.shardsTotal} shards stored
            {stripes > 0 ? ` · stripe ${currentStripe} of ${stripes}` : ''}
          </span>
        )}
        {!isMine && !interrupted && (
          <button
            type="button"
            aria-pressed={watching}
            onClick={onToggleWatch}
            className={`h-8 shrink-0 rounded-lg border px-3 text-xs font-semibold ${watching ? 'border-blue-500/60 bg-blue-500/15 text-blue-200' : 'border-white/10 text-slate-200 hover:bg-white/5'}`}
          >
            {watching ? 'Will notify' : 'Notify me'}
          </button>
        )}
      </div>
    </article>
  );
}

interface IRoomActivityProps {
  files: ILariaMetadata[];
  uploads: IUploadStatus[];
  online: number;
  myMemberId: string | null;
  expiryText: string | null;
  newFiles: Record<string, number>;
  thumbnails: Record<string, string>;
  watching: Set<string>;
  now: number;
  onToggleWatch: (uploadId: string) => void;
  onOpenFile: (filename: string) => void;
}

/**
 * Info: (20261105 - Luphia)
 * 房間首頁 (C 方案)：進房即看到正在上傳與最近新增的檔案，內容即時更新
 */
export default function RoomActivity({
  files,
  uploads,
  online,
  myMemberId,
  expiryText,
  newFiles,
  thumbnails,
  watching,
  now,
  onToggleWatch,
  onOpenFile,
}: IRoomActivityProps) {
  const uploading = uploads.filter(u => u.status === 'uploading').length;
  const recent = [...files]
    .sort((a, b) => (newFiles[b.filename] ?? b.uploadedAt ?? 0) - (newFiles[a.filename] ?? a.uploadedAt ?? 0))
    .slice(0, MAX_RECENT_FILES);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-7">
      <div className="mx-auto flex max-w-5xl flex-col gap-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-100">Room activity</h1>
            <p className="mt-1.5 text-[13px] text-slate-400">
              Updates live while you are here{expiryText ? ` · ${expiryText.toLowerCase()}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-slate-300">{files.length} ready</span>
            <span className={`rounded-full border px-3 py-1.5 ${uploading ? 'border-blue-800 bg-blue-950 text-blue-200' : 'border-white/10 text-slate-300'}`}>
              {uploading} uploading
            </span>
            <span className="rounded-full border border-white/10 px-3 py-1.5 text-slate-300">
              {online} {online === 1 ? 'person' : 'people'} here
            </span>
          </div>
        </header>

        {uploads.length > 0 && (
          <section aria-labelledby="activity-uploading" className="flex flex-col gap-3">
            <h2 id="activity-uploading" className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
              Uploading now
            </h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {uploads.map(upload => (
                <UploadCard
                  key={upload.uploadId}
                  upload={upload}
                  isMine={upload.uploader.memberId === myMemberId}
                  watching={watching.has(upload.uploadId)}
                  onToggleWatch={() => onToggleWatch(upload.uploadId)}
                />
              ))}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section aria-labelledby="activity-recent" className="flex flex-col gap-3">
            <h2 id="activity-recent" className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">
              Recently added
            </h2>
            <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-3 2xl:grid-cols-4">
              {recent.map(file => {
                const kind = getFileKind(file.filename, file.mimeType);
                const addedAt = newFiles[file.filename];
                const isNew = addedAt !== undefined && now - addedAt < NEW_FILE_WINDOW_MS;
                const timestamp = addedAt ?? file.uploadedAt;
                const thumbnail = thumbnails[file.filename];
                return (
                  <button
                    key={file.filename}
                    type="button"
                    onClick={() => onOpenFile(file.filename)}
                    className={`group overflow-hidden rounded-[14px] border bg-[#0B1222] text-left transition-colors hover:bg-[#0F182C] ${isNew ? 'border-emerald-700' : 'border-white/10'}`}
                  >
                    <span className="flex h-[110px] items-center justify-center overflow-hidden bg-slate-900">
                      {thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <TypeTile filename={file.filename} kind={kind} className="h-14 w-14 text-xs" />
                      )}
                    </span>
                    <span className="flex flex-col gap-1 px-3 py-2.5">
                      <span className="truncate text-[13px] font-semibold text-slate-100">{file.filename}</span>
                      <span className={`text-[11px] ${isNew ? 'text-emerald-300' : 'text-slate-400'}`}>
                        {isNew ? `Ready · ${formatRelative(addedAt, now)}` : `${timestamp && now ? `${formatRelative(timestamp, now)} · ` : ''}${formatBytes(file.originalFileSize)}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {files.length === 0 && uploads.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center">
            <p className="text-sm font-semibold text-slate-200">Nothing here yet</p>
            <p className="mt-1 text-[13px] text-slate-400">Files appear here as soon as someone starts uploading.</p>
          </div>
        )}
      </div>
    </div>
  );
}
