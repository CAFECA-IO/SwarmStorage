import type { ILariaMetadata } from '@/lib/file_operator';

/**
 * Info: (20261108 - Luphia)
 * 以檔名中的 / 組出資料夾結構 (伺服器只保存檔案，資料夾由路徑推得)
 */

export interface IFolderSummary {
  // Info: (20261108 - Luphia) 完整路徑 (例：experiment/raw)
  path: string;
  name: string;
  count: number;
  size: number;
  // Info: (20261108 - Luphia) 最近一個檔案的上傳時間
  latest: number;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const isInFolder = (filename: string, folder: string) => filename.startsWith(`${folder}/`);

export const filesUnder = (files: ILariaMetadata[], folder: string) => files.filter(f => isInFolder(f.filename, folder));

/**
 * Info: (20261108 - Luphia)
 * 某個資料夾 (空字串為房間根目錄) 底下第一層的子資料夾與檔案
 */
export function listChildren(files: ILariaMetadata[], folder: string): { folders: IFolderSummary[]; files: ILariaMetadata[] } {
  const prefix = folder ? `${folder}/` : '';
  const folders = new Map<string, IFolderSummary>();
  const direct: ILariaMetadata[] = [];
  files.forEach(file => {
    if (!file.filename.startsWith(prefix)) return;
    const rest = file.filename.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      direct.push(file);
      return;
    }
    const name = rest.slice(0, slash);
    const summary = folders.get(name) ?? { path: `${prefix}${name}`, name, count: 0, size: 0, latest: 0 };
    summary.count += 1;
    summary.size += file.originalFileSize || 0;
    summary.latest = Math.max(summary.latest, file.uploadedAt ?? 0);
    folders.set(name, summary);
  });
  return {
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: direct.sort((a, b) => a.filename.localeCompare(b.filename)),
  };
}

// Info: (20261108 - Luphia) 已存在的第一層名稱 (檔案或資料夾) 時改為「名稱 (2)」
export function freeTopName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

export const topLevelNames = (filenames: string[]) => new Set(filenames.map(f => (f.includes('/') ? f.slice(0, f.indexOf('/')) : f)));
