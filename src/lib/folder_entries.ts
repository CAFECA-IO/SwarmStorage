/**
 * Info: (20261108 - Luphia)
 * 讀取使用者拖曳或選擇的資料夾，保留相對路徑 (例：experiment/raw/run-001.csv)
 * - 拖曳：DataTransferItem.webkitGetAsEntry() 遞迴讀取 (readEntries 每次最多回傳 100 筆，需重複呼叫)
 * - 選擇資料夾：<input webkitdirectory> 的 File.webkitRelativePath
 * 系統產生的檔案 (.DS_Store、Thumbs.db、__MACOSX 等) 一律略過
 */

export const MAX_FOLDER_FILES = 2000;
export const MAX_FOLDER_DEPTH = 16;

export interface IPathedFile {
  file: File;
  // Info: (20261108 - Luphia) 以 / 分隔的相對路徑；不在資料夾中的檔案就是檔名
  path: string;
}

export interface ICollectedFiles {
  files: IPathedFile[];
  skipped: number;
  truncated: boolean;
}

const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized', 'icon\r']);
const isJunk = (name: string) => JUNK_NAMES.has(name.toLowerCase()) || name.startsWith('._');
const isJunkDir = (name: string) => name === '__MACOSX' || name === '.git' || name === '.Trashes' || name === '.Spotlight-V100';

// Info: (20261108 - Luphia) 路徑每一段都要能被伺服器接受 (不可為空、. 或 ..，不含反斜線與控制字元)
const cleanSegment = (segment: string) => segment.replace(/[\\\u0000-\u001f\u007f]/g, '_').trim();
export const normalizePath = (raw: string): string | null => {
  const segments = raw.split('/').map(cleanSegment).filter(Boolean);
  if (segments.length === 0 || segments.length > MAX_FOLDER_DEPTH + 1) return null;
  if (segments.some(seg => seg === '.' || seg === '..')) return null;
  // Info: (20261108 - Luphia) 伺服器不接受以 . 開頭的路徑 (第一段)
  if (segments[0].startsWith('.')) segments[0] = `_${segments[0].slice(1)}`;
  return segments.join('/');
};

const readAllEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries(batch => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });

const entryFile = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));

export async function collectDropped(dataTransfer: DataTransfer): Promise<ICollectedFiles> {
  const result: ICollectedFiles = { files: [], skipped: 0, truncated: false };
  const entries = Array.from(dataTransfer.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));

  // Info: (20261108 - Luphia) 不支援 webkitGetAsEntry 的瀏覽器：只取得檔案本身
  if (entries.every(entry => !entry)) {
    Array.from(dataTransfer.files).forEach(file => {
      if (isJunk(file.name)) result.skipped++;
      else result.files.push({ file, path: file.name });
    });
    return result;
  }

  const walk = async (entry: FileSystemEntry, prefix: string, depth: number) => {
    if (result.files.length >= MAX_FOLDER_FILES) {
      result.truncated = true;
      return;
    }
    if (entry.isFile) {
      if (isJunk(entry.name)) {
        result.skipped++;
        return;
      }
      const file = await entryFile(entry as FileSystemFileEntry);
      const path = normalizePath(`${prefix}${entry.name}`);
      if (path) result.files.push({ file, path });
      else result.skipped++;
    } else if (entry.isDirectory) {
      if (isJunkDir(entry.name) || depth >= MAX_FOLDER_DEPTH) {
        result.skipped++;
        return;
      }
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) await walk(child, `${prefix}${entry.name}/`, depth + 1);
    }
  };

  for (const entry of entries) if (entry) await walk(entry, '', 0);
  return result;
}

export function collectPicked(list: FileList): ICollectedFiles {
  const result: ICollectedFiles = { files: [], skipped: 0, truncated: false };
  for (const file of Array.from(list)) {
    if (result.files.length >= MAX_FOLDER_FILES) {
      result.truncated = true;
      break;
    }
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const segments = relative.split('/');
    if (isJunk(file.name) || segments.slice(0, -1).some(isJunkDir)) {
      result.skipped++;
      continue;
    }
    const path = normalizePath(relative);
    if (path) result.files.push({ file, path });
    else result.skipped++;
  }
  return result;
}

export const topFolderOf = (path: string): string | null => (path.includes('/') ? path.slice(0, path.indexOf('/')) : null);
