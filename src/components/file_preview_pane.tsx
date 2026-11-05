import type { Ref } from 'react';
import type { ILariaMetadata } from '@/lib/file_operator';
import type { IHtmlOutlineItem, IHtmlPreviewOptions, IPreparedHtml, IRoomFileResolver } from '@/lib/html_preview';
import { FILE_KIND_LABELS, getFileKind } from '@/lib/file_types';
import { formatBytes } from '@/lib/utils';
import { DownloadIcon } from '@/components/icons';
import HtmlViewer, { type IHtmlViewerHandle } from '@/components/html_viewer';

export type TViewMode = 'reading' | 'full' | 'source';

export interface IFileLoadState {
  status: 'loading' | 'ready' | 'error';
  progress: number;
  blob?: Blob;
  url?: string;
  text?: string;
  error?: string;
}

interface IFilePreviewPaneProps {
  file: ILariaMetadata;
  load: IFileLoadState | undefined;
  viewMode: TViewMode;
  previewOptions: IHtmlPreviewOptions;
  resolver: IRoomFileResolver;
  viewerRef: Ref<IHtmlViewerHandle>;
  canDownload: boolean;
  onLoad: () => void;
  onDownload: () => void;
  onOutline: (outline: IHtmlOutlineItem[]) => void;
  onActiveHeading: (id: string) => void;
  onOpenFile: (filename: string) => void;
  onFindResult: (result: { found: boolean; index: number; total: number }) => void;
  onPrepared: (prepared: IPreparedHtml) => void;
}

const MAX_SOURCE_LINES = 5000;

function CodeView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, MAX_SOURCE_LINES);
  return (
    <div className="h-full overflow-auto bg-slate-950 font-mono text-[12.5px] leading-6">
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((line, i) => (
            <tr key={i}>
              <td className="select-none pr-4 pl-4 text-right align-top text-slate-500 w-[1%] whitespace-nowrap">{i + 1}</td>
              <td className="pr-6 text-slate-200 whitespace-pre-wrap break-all">{line || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lines.length > MAX_SOURCE_LINES && (
        <p className="px-4 py-3 text-xs text-slate-400">
          Showing the first {MAX_SOURCE_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines. Download the file to see the rest.
        </p>
      )}
    </div>
  );
}

function CenterCard({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
        <h2 className="text-base font-bold text-slate-100">{title}</h2>
        <p className="mt-2 text-sm text-slate-400">{body}</p>
        {children && <div className="mt-5 flex flex-wrap justify-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

/**
 * Info: (20261105 - Luphia)
 * 依檔案類型選擇預覽方式
 */
export default function FilePreviewPane({
  file,
  load,
  viewMode,
  previewOptions,
  resolver,
  viewerRef,
  canDownload,
  onLoad,
  onDownload,
  onOutline,
  onActiveHeading,
  onOpenFile,
  onFindResult,
  onPrepared,
}: IFilePreviewPaneProps) {
  const kind = getFileKind(file.filename, file.mimeType);

  const downloadButton = canDownload ? (
    <button
      type="button"
      onClick={onDownload}
      className="inline-flex h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-500"
    >
      <DownloadIcon className="h-4 w-4" /> Download
    </button>
  ) : null;

  if (kind === 'other') {
    return (
      <CenterCard
        title="No preview for this file type"
        body={`${file.filename} · ${formatBytes(file.originalFileSize)}${canDownload ? '' : ' · The uploader turned off downloads for this file.'}`}
      >
        {downloadButton}
      </CenterCard>
    );
  }

  if (!load) {
    return (
      <CenterCard
        title={`Large ${FILE_KIND_LABELS[kind].toLowerCase()}`}
        body={`This file is ${formatBytes(file.originalFileSize)}. Loading the preview downloads the whole file.`}
      >
        <button
          type="button"
          onClick={onLoad}
          className="inline-flex h-11 items-center rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5"
        >
          Load preview
        </button>
        {downloadButton}
      </CenterCard>
    );
  }

  if (load.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-xs">
          <div className="mb-2 flex justify-between text-xs text-slate-400 font-mono">
            <span>Fetching shards…</span>
            <span>{Math.round(load.progress)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={Math.round(load.progress)} aria-valuemin={0} aria-valuemax={100} aria-label={`Loading ${file.filename}`}>
            <div className="h-full rounded-full bg-blue-500 transition-all duration-300" style={{ width: `${load.progress}%` }} />
          </div>
        </div>
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <CenterCard title="Could not load this file" body={load.error || 'Unknown error'}>
        <button
          type="button"
          onClick={onLoad}
          className="inline-flex h-11 items-center rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5"
        >
          Try again
        </button>
      </CenterCard>
    );
  }

  const preventContext = (e: React.MouseEvent) => e.preventDefault();

  if ((kind === 'html' || kind === 'text') && load.text !== undefined) {
    if (kind === 'text' || viewMode === 'source') return <CodeView text={load.text} />;
    return (
      <HtmlViewer
        ref={viewerRef}
        filename={file.filename}
        html={load.text}
        options={previewOptions}
        resolver={resolver}
        fullWidth={viewMode === 'full'}
        onOutline={onOutline}
        onActiveHeading={onActiveHeading}
        onOpenFile={onOpenFile}
        onFindResult={onFindResult}
        onPrepared={onPrepared}
      />
    );
  }

  if (!load.url) {
    return <CenterCard title="Preview unavailable" body="The file was loaded but cannot be displayed.">{downloadButton}</CenterCard>;
  }

  if (kind === 'image') {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={load.url} alt={file.filename} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl shadow-black/40" onContextMenu={preventContext} />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video controls controlsList="nodownload" src={load.url} className="max-h-full max-w-full rounded-lg bg-black" aria-label={`Video ${file.filename}`} onContextMenu={preventContext} />
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio controls controlsList="nodownload" src={load.url} className="w-full max-w-md" aria-label={`Audio ${file.filename}`} onContextMenu={preventContext} />
      </div>
    );
  }

  return <iframe src={`${load.url}#toolbar=0`} title={`PDF ${file.filename}`} className="h-full w-full bg-white" />;
}
