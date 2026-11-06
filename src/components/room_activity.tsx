import type { ILariaMetadata } from '@/lib/file_operator';
import type { IUploadStatus } from '@/lib/chat_hub';
import { getExtension, getFileKind, type TFileKind } from '@/lib/file_types';
import { formatBytes } from '@/lib/utils';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import FileActionsMenu, { type IFileAction } from '@/components/file_actions_menu';
import RoomSharePanel from '@/components/room_share_panel';
import { ShareIcon, UploadIcon } from '@/components/icons';

const SHARDS_PER_STRIPE = 8;
const DATA_SHARDS = 5;
// Info: (20261105 - Luphia) 分片數不多時逐格顯示，否則改為進度條
const MAX_SHARD_CELLS = 48;
// Info: (20261105 - Luphia) 進房後新增的檔案在 10 分鐘內標示為新檔案
const NEW_FILE_WINDOW_MS = 10 * 60 * 1000;

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

const SWIPE_WIDTH = 96;

/**
 * Info: (20261106 - Luphia)
 * 手機版檔案列：自己上傳的檔案可向左滑出「刪除」；其他操作在 ⋯ 選單 (鍵盤與螢幕閱讀器可用)
 */
function SwipeRow({
  children,
  canDelete,
  onDelete,
  onOpen,
  label,
}: {
  children: React.ReactNode;
  canDelete: boolean;
  onDelete: () => void;
  onOpen: () => void;
  label: string;
}) {
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ startX: number; base: number; moved: boolean } | null>(null);
  // Info: (20261106 - Luphia) 拖曳結束後緊接的 click 不視為開啟檔案
  const movedRef = useRef(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (!canDelete) return;
    drag.current = { startX: e.clientX, base: offset, moved: false };
    movedRef.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const state = drag.current;
    if (!state) return;
    const dx = e.clientX - state.startX;
    if (Math.abs(dx) > 6) {
      state.moved = true;
      movedRef.current = true;
    }
    setOffset(Math.max(-SWIPE_WIDTH, Math.min(0, state.base + dx)));
  };
  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    setOffset(prev => (prev < -SWIPE_WIDTH / 2 ? -SWIPE_WIDTH : 0));
  };

  return (
    <li className="relative overflow-hidden border-b border-white/10 bg-red-900/60 last:border-0">
      {canDelete && (
        <button
          type="button"
          tabIndex={offset === 0 ? -1 : 0}
          onClick={() => {
            setOffset(0);
            onDelete();
          }}
          className="absolute inset-y-0 right-0 w-24 bg-red-600 text-[13px] font-bold text-white"
        >
          Delete
        </button>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative flex min-h-16 touch-pan-y items-center gap-3 bg-slate-950 px-1 transition-transform duration-150"
        style={{ transform: `translateX(${offset}px)` }}
      >
        <button
          type="button"
          aria-label={`Open ${label}`}
          onClick={() => {
            if (movedRef.current) {
              movedRef.current = false;
              return;
            }
            if (offset !== 0) {
              setOffset(0);
              return;
            }
            onOpen();
          }}
          className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
        >
          {children}
        </button>
      </div>
    </li>
  );
}

interface IRoomActivityProps {
  roomId: string;
  roomName: string;
  uploadPolicy: 'owner' | 'everyone';
  isOwner: boolean;
  canUpload: boolean;
  myUploaderId: string | null;
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
  onUpload: () => void;
  getActions: (file: ILariaMetadata) => IFileAction[];
  canDelete: (file: ILariaMetadata) => boolean;
  onDelete: (file: ILariaMetadata) => void;
  // Info: (20261106 - Luphia) 通話按鈕 (未啟用通話時為 null)
  callAction?: React.ReactNode;
}

/**
 * Info: (20261105 - Luphia)
 * 房間首頁 (C 方案)：進房即看到正在上傳與最近新增的檔案，內容即時更新
 * Info: (20261106 - Luphia) 加入房間名稱、上傳權限、上傳 / 分享按鈕與檔案操作 (自己的檔案可刪除)
 */
export default function RoomActivity({
  roomId,
  roomName,
  uploadPolicy,
  isOwner,
  canUpload,
  myUploaderId,
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
  onUpload,
  getActions,
  canDelete,
  onDelete,
  callAction = null,
}: IRoomActivityProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const uploading = uploads.filter(u => u.status === 'uploading').length;
  const recent = [...files].sort(
    (a, b) => (newFiles[b.filename] ?? b.uploadedAt ?? 0) - (newFiles[a.filename] ?? a.uploadedAt ?? 0)
  );
  const isMine = (file: ILariaMetadata) => !!myUploaderId && file.uploaderId === myUploaderId;
  const uploaderLabel = (file: ILariaMetadata) => (isMine(file) ? 'You' : file.uploaderId ? 'Someone else' : 'Earlier upload');

  return (
    <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-7">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">
              ← All rooms
            </Link>
            <h1 className="mt-1.5 text-2xl font-bold text-slate-100">
              {roomName} <span className="font-mono text-sm font-normal text-slate-400">#{roomId}</span>
            </h1>
            <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
              <span className="rounded-md bg-slate-800 px-2 py-1 text-slate-300">
                {uploadPolicy === 'everyone' ? 'Everyone uploads' : 'Owner uploads only'}
              </span>
              <span className="rounded-md bg-slate-800 px-2 py-1 text-slate-300">Delete your own files</span>
              {isOwner && <span className="rounded-md bg-blue-950 px-2 py-1 text-blue-200">You own this room</span>}
              {expiryText && <span className="rounded-md bg-slate-800 px-2 py-1 text-slate-300">{expiryText}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {callAction}
            <button
              type="button"
              aria-expanded={shareOpen}
              onClick={() => setShareOpen(v => !v)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-white/10 px-4 text-[13px] font-semibold text-slate-200 hover:bg-white/5"
            >
              <ShareIcon className="h-4 w-4" />
              Share
            </button>
            {canUpload && (
              <button
                type="button"
                onClick={onUpload}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-[13px] font-semibold text-white hover:bg-blue-500"
              >
                <UploadIcon className="h-4 w-4" />
                Upload files
              </button>
            )}
          </div>
        </header>

        {shareOpen && (
          <div className="max-w-md">
            <RoomSharePanel roomNumber={roomId} />
          </div>
        )}

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-white/10 px-3 py-1.5 text-slate-300">{files.length} ready</span>
          <span className={`rounded-full border px-3 py-1.5 ${uploading ? 'border-blue-800 bg-blue-950 text-blue-200' : 'border-white/10 text-slate-300'}`}>
            {uploading} uploading
          </span>
          <span className="rounded-full border border-white/10 px-3 py-1.5 text-slate-300">
            {online} {online === 1 ? 'person' : 'people'} here
          </span>
        </div>

        {canUpload ? (
          <p className="hidden rounded-[14px] border border-dashed border-slate-700 p-3.5 text-center text-[13px] text-slate-400 md:block">
            Drop files anywhere on this page to add them to the room
          </p>
        ) : (
          <p className="rounded-[14px] border border-white/10 bg-white/5 p-3 text-center text-[13px] text-slate-400">
            Only the room owner can add files here.
          </p>
        )}

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
              Files
            </h2>

            {/* Info: (20261106 - Luphia) 桌面版：卡片 + ⋯ 選單 */}
            <div className="hidden grid-cols-2 gap-3.5 md:grid lg:grid-cols-3 2xl:grid-cols-4">
              {recent.map(file => {
                const kind = getFileKind(file.filename, file.mimeType);
                const addedAt = newFiles[file.filename];
                const isNew = addedAt !== undefined && now - addedAt < NEW_FILE_WINDOW_MS;
                const timestamp = addedAt ?? file.uploadedAt;
                const thumbnail = thumbnails[file.filename];
                const mine = isMine(file);
                return (
                  <div
                    key={file.filename}
                    className={`group rounded-[14px] border bg-[#0B1222] transition-colors hover:bg-[#0F182C] ${mine ? 'border-blue-800' : isNew ? 'border-emerald-700' : 'border-white/10'}`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenFile(file.filename)}
                      aria-label={`Open ${file.filename}`}
                      className="flex h-[110px] w-full items-center justify-center overflow-hidden rounded-t-[14px] bg-slate-900"
                    >
                      {thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <TypeTile filename={file.filename} kind={kind} className="h-14 w-14 text-xs" />
                      )}
                    </button>
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-slate-100">{file.filename}</p>
                        <p className={`text-[11px] ${isNew ? 'text-emerald-300' : mine ? 'text-blue-300' : 'text-slate-400'}`}>
                          {isNew
                            ? `Ready · ${formatRelative(addedAt, now)}`
                            : `${uploaderLabel(file)} · ${timestamp && now ? `${formatRelative(timestamp, now)} · ` : ''}${formatBytes(file.originalFileSize)}`}
                        </p>
                      </div>
                      <FileActionsMenu filename={file.filename} actions={getActions(file)} highlighted={mine} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Info: (20261106 - Luphia) 手機版：清單，自己的檔案可左滑刪除 */}
            <ul className="md:hidden">
              {recent.map(file => {
                const kind = getFileKind(file.filename, file.mimeType);
                const mine = isMine(file);
                return (
                  <SwipeRow
                    key={file.filename}
                    label={file.filename}
                    canDelete={canDelete(file)}
                    onDelete={() => onDelete(file)}
                    onOpen={() => onOpenFile(file.filename)}
                  >
                    <TypeTile filename={file.filename} kind={kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-100">{file.filename}</span>
                      <span className={`text-xs ${mine ? 'text-blue-300' : 'text-slate-400'}`}>
                        {uploaderLabel(file)} · {formatBytes(file.originalFileSize)}
                      </span>
                    </span>
                  </SwipeRow>
                );
              })}
            </ul>
            <p className="text-xs text-slate-500 md:hidden">Swipe left on a file you uploaded to delete it.</p>
          </section>
        )}

        {files.length === 0 && uploads.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center">
            <p className="text-sm font-semibold text-slate-200">Nothing here yet</p>
            <p className="mt-1 text-[13px] text-slate-400">
              {canUpload ? 'Upload files or drop them here to get started.' : 'Files appear here as soon as the owner uploads them.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
