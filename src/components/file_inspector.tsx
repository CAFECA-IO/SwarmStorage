import { isDownloadAllowed, isParityProtected, type ILariaMetadata, type IShardStats } from '@/lib/file_operator';
import type { IHtmlPreviewOptions } from '@/lib/html_preview';
import { FILE_KIND_LABELS, getFileKind, guessMimeType } from '@/lib/file_types';
import { formatBytes } from '@/lib/utils';
import { DownloadIcon } from '@/components/icons';
import ToggleSwitch from '@/components/toggle_switch';

const SHARDS_PER_STRIPE = 8;

export interface IRepairState {
  status: 'running' | 'done' | 'error';
  progress: number;
  message?: string;
}

interface IFileInspectorProps {
  file: ILariaMetadata;
  shardStats?: IShardStats;
  downloadProgress: number | null;
  linkCopied: boolean;
  previewOptions: IHtmlPreviewOptions;
  inlinedFiles: string[];
  repair?: IRepairState;
  onPreviewOptionsChange: (options: IHtmlPreviewOptions) => void;
  onDownload: () => void;
  onCopyLink: () => void;
  onPrint: () => void;
  onRepair: () => void;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">{children}</h2>;
}

const formatDate = (timestamp?: number) =>
  timestamp ? new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

/**
 * Info: (20261105 - Luphia)
 * 右側檔案資訊面板：操作、檔案資訊、儲存健康度 (含重建遺失分片)、預覽安全設定
 */
export default function FileInspector({
  file,
  shardStats,
  downloadProgress,
  linkCopied,
  previewOptions,
  inlinedFiles,
  repair,
  onPreviewOptionsChange,
  onDownload,
  onCopyLink,
  onPrint,
  onRepair,
}: IFileInspectorProps) {
  const kind = getFileKind(file.filename, file.mimeType);
  const isHtml = kind === 'html';
  const canDownload = isDownloadAllowed(file);
  const hasParity = isParityProtected(file);
  const shardCount = file.shards.length;
  const stripes = Math.ceil(shardCount / SHARDS_PER_STRIPE);
  const k = file.algorithm?.k ?? 5;
  const m = file.algorithm?.m ?? 3;
  const uploaded = formatDate(file.uploadedAt);
  const repairedAt = formatDate(file.repairedAt);

  const missingCount = shardStats ? shardStats.missingData + shardStats.missingParity : 0;
  const canRepair = hasParity && missingCount > 0 && repair?.status !== 'running';

  let healthText = 'Checked when the file is opened.';
  let healthTone = 'text-slate-400';
  if (shardStats) {
    if (missingCount === 0) {
      healthText = `All ${shardStats.total} shards retrieved.`;
      healthTone = 'text-emerald-400';
    } else if (!hasParity && shardStats.missingData > 0) {
      healthText = `${shardStats.missingData} data shard${shardStats.missingData > 1 ? 's' : ''} missing. This file was uploaded before parity protection and cannot be rebuilt.`;
      healthTone = 'text-red-400';
    } else if (shardStats.reconstructed) {
      healthText = `${missingCount} shard${missingCount > 1 ? 's' : ''} missing. The file was rebuilt from parity.`;
      healthTone = 'text-amber-300';
    } else {
      healthText = `${missingCount} parity shard${missingCount > 1 ? 's' : ''} missing. Data is intact.`;
      healthTone = 'text-amber-300';
    }
  }

  // Info: (20261105 - Luphia) 標示第一個遺失分片的位置 (以條帶內的序號表示)
  const missingSlots = new Set((shardStats?.missing || []).map(s => s.index));

  const setOption = (key: keyof IHtmlPreviewOptions) => (value: boolean) =>
    onPreviewOptionsChange({ ...previewOptions, [key]: value });

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex flex-col gap-2">
        {canDownload ? (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloadProgress !== null}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 text-[13px] font-semibold text-white hover:bg-blue-500 disabled:opacity-70"
          >
            <DownloadIcon className="h-4 w-4" />
            {downloadProgress !== null ? `Downloading ${Math.round(downloadProgress)}%` : 'Download'}
          </button>
        ) : (
          <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-center text-xs text-slate-300">
            View only · the uploader turned off downloads
          </p>
        )}
        <div className={`grid gap-2 ${isHtml && canDownload ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <button
            type="button"
            onClick={onCopyLink}
            className="h-10 rounded-xl border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5"
          >
            {linkCopied ? 'Link copied' : 'Copy link'}
          </button>
          {isHtml && canDownload && (
            <button
              type="button"
              onClick={onPrint}
              className="h-10 rounded-xl border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5"
            >
              Print / PDF
            </button>
          )}
        </div>
      </div>

      <section className="flex flex-col gap-2.5">
        <SectionTitle>Details</SectionTitle>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2.5 gap-y-2 text-[13px]">
          <dt className="text-slate-400">Name</dt>
          <dd className="break-all text-slate-200">{file.filename}</dd>
          <dt className="text-slate-400">Type</dt>
          <dd className="text-slate-200">{FILE_KIND_LABELS[kind]}</dd>
          <dt className="text-slate-400">MIME</dt>
          <dd className="truncate font-mono text-xs leading-5 text-slate-200">{guessMimeType(file.filename, file.mimeType)}</dd>
          <dt className="text-slate-400">Size</dt>
          <dd className="text-slate-200">{formatBytes(file.originalFileSize)}</dd>
          {uploaded && (
            <>
              <dt className="text-slate-400">Uploaded</dt>
              <dd className="text-slate-200">{uploaded}</dd>
            </>
          )}
          <dt className="text-slate-400">Downloads</dt>
          <dd className="text-slate-200">{canDownload ? 'Allowed' : 'Off (view only)'}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionTitle>Storage health</SectionTitle>
        <div className="grid grid-cols-8 gap-1" role="img" aria-label={`Each stripe: ${k} data shards and ${m} parity shards${missingSlots.size ? `; missing positions ${[...missingSlots].map(i => i + 1).join(', ')}` : ''}`}>
          {Array.from({ length: k + m }, (_, i) => (
            <span
              key={i}
              className={`h-7 rounded border ${missingSlots.has(i)
                ? 'border-dashed border-red-400 bg-red-950/60'
                : i < k
                  ? 'border-blue-500 bg-blue-900/60'
                  : 'border-amber-500 bg-amber-900/50'}`}
            />
          ))}
        </div>
        <p className="text-xs text-slate-400">
          {stripes} stripe{stripes === 1 ? '' : 's'} × ({k} data + {m} parity) ·{' '}
          {hasParity ? `Reed-Solomon (${k + m}, ${k})` : 'legacy upload, no parity'}
        </p>
        <p className={`text-xs font-medium ${healthTone}`}>{healthText}</p>

        {canRepair && (
          <button
            type="button"
            onClick={onRepair}
            className="h-10 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs font-semibold text-amber-200 hover:bg-amber-500/20"
          >
            Rebuild {missingCount} missing shard{missingCount > 1 ? 's' : ''}
          </button>
        )}
        {repair?.status === 'running' && (
          <div>
            <div className="mb-1 flex justify-between font-mono text-[11px] text-slate-400">
              <span>Rebuilding shards…</span>
              <span>{Math.round(repair.progress)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${repair.progress}%` }} />
            </div>
          </div>
        )}
        {repair?.status === 'done' && <p className="text-xs text-emerald-400">{repair.message}</p>}
        {repair?.status === 'error' && <p className="text-xs text-red-400">{repair.message}</p>}
        {repairedAt && repair?.status !== 'done' && <p className="text-[11px] text-slate-400">Last repaired {repairedAt}</p>}
      </section>

      <section className="flex flex-col gap-1">
        <SectionTitle>Preview safety</SectionTitle>
        <p className="mb-1 text-[11px] text-slate-400">
          {isHtml ? 'HTML opens in an isolated sandbox.' : 'Applies when an HTML document is open.'}
        </p>
        <ToggleSwitch
          id="preview-scripts"
          label="Run page scripts"
          description={previewOptions.allowScripts ? 'On · runs isolated from DropHere' : 'Off · inline and remote JS blocked'}
          checked={previewOptions.allowScripts}
          onChange={setOption('allowScripts')}
        />
        <ToggleSwitch
          id="preview-external"
          label="Load external resources"
          description={previewOptions.allowExternal ? 'On · may reveal your IP to other sites' : 'Off · images, fonts, CSS from other sites'}
          checked={previewOptions.allowExternal}
          onChange={setOption('allowExternal')}
        />
        <ToggleSwitch
          id="preview-room-files"
          label="Resolve links to room files"
          description="Images, CSS and pages in this room"
          checked={previewOptions.resolveRoomFiles}
          onChange={setOption('resolveRoomFiles')}
        />
        {isHtml && inlinedFiles.length > 0 && (
          <p className="mt-1 break-all text-[11px] text-slate-400">Using from this room: {inlinedFiles.join(', ')}</p>
        )}
      </section>
    </div>
  );
}
