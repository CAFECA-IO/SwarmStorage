/**
 * Info: (20261105 - Luphia)
 * 檔案類型判斷：決定瀏覽器內的預覽方式與檔案分組
 */

export type TFileKind = 'html' | 'markdown' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other';
export type TFileGroup = 'documents' | 'media' | 'other';

const KIND_BY_EXTENSION: Record<string, TFileKind> = {
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  pdf: 'pdf',
  txt: 'text',
  // Info: (20261106 - Luphia) Markdown 以排版後的文件呈現 (含 mermaid、數學式)
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  json: 'text',
  csv: 'text',
  log: 'text',
  xml: 'text',
  yml: 'text',
  yaml: 'text',
  css: 'text',
  js: 'text',
  ts: 'text',
};

// Info: (20261105 - Luphia) SVG 可內嵌腳本，一律以 <img> 顯示 (瀏覽器不會執行 <img> 內的腳本)
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  svg: 'image/svg+xml',
};

export const getExtension = (filename: string): string => {
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index + 1).toLowerCase();
};

export const getFileKind = (filename: string, mimeType?: string): TFileKind => {
  const ext = getExtension(filename);
  if (IMAGE_MIME_BY_EXTENSION[ext]) return 'image';
  const byExt = KIND_BY_EXTENSION[ext];
  if (byExt) return byExt;
  if (!mimeType) return 'other';
  if (mimeType === 'text/html') return 'html';
  if (mimeType === 'text/markdown') return 'markdown';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  return 'other';
};

// Info: (20261106 - Luphia) 以 sandbox 文件方式呈現的類型 (支援目錄、頁內搜尋、列印)
export const isRenderedDocument = (kind: TFileKind | null): boolean => kind === 'html' || kind === 'markdown';

export const getFileGroup = (kind: TFileKind): TFileGroup => {
  if (kind === 'html' || kind === 'markdown' || kind === 'pdf' || kind === 'text') return 'documents';
  if (kind === 'image' || kind === 'video' || kind === 'audio') return 'media';
  return 'other';
};

export const FILE_GROUP_LABELS: Record<TFileGroup, string> = {
  documents: 'Documents',
  media: 'Media',
  other: 'Other',
};

export const FILE_KIND_LABELS: Record<TFileKind, string> = {
  html: 'HTML document',
  markdown: 'Markdown document',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF document',
  text: 'Text file',
  other: 'File',
};

// Info: (20261105 - Luphia) 每種類型的標記色 (Tailwind class)
export const FILE_KIND_DOT: Record<TFileKind, string> = {
  html: 'bg-orange-400',
  markdown: 'bg-emerald-400',
  image: 'bg-violet-400',
  video: 'bg-pink-400',
  audio: 'bg-teal-400',
  pdf: 'bg-red-400',
  text: 'bg-sky-400',
  other: 'bg-slate-400',
};

/**
 * Info: (20261105 - Luphia)
 * 以副檔名推定 MIME，修正上傳時瀏覽器未提供 type 的情況
 */
export const guessMimeType = (filename: string, fallback?: string): string => {
  const ext = getExtension(filename);
  if (IMAGE_MIME_BY_EXTENSION[ext]) return IMAGE_MIME_BY_EXTENSION[ext];
  if (fallback) return fallback;
  const map: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    md: 'text/markdown',
    markdown: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
    css: 'text/css',
    js: 'text/javascript',
    json: 'application/json',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
};
