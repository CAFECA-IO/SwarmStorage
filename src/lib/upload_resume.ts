/**
 * Info: (20261110 - Luphia)
 * 未完成的單一檔案上傳：記住已存好的分片 CID，重新整理或關閉分頁後，選回同一個檔案即可續傳
 * 分片以內容定址，同一個檔案重新切割的分片與先前相同，已存好的分片不必再上傳
 * 只存在這個瀏覽器 (localStorage)；保留 3 天
 */

const STORAGE_KEY = 'drophere.unfinishedUploads.v1';
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

export interface IUnfinishedUpload {
  roomId: string;
  uploadId: string;
  // Info: (20261110 - Luphia) 房間內的檔名 (可能與原始檔名不同)
  path: string;
  name: string;
  size: number;
  lastModified: number;
  mimeType: string;
  stored: (string | null)[];
  savedAt: number;
}

const readAll = (): IUnfinishedUpload[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (e): e is IUnfinishedUpload =>
        !!e && typeof e.uploadId === 'string' && typeof e.roomId === 'string' && Array.isArray(e.stored) && now - e.savedAt < KEEP_MS
    );
  } catch {
    return [];
  }
};

const writeAll = (entries: IUnfinishedUpload[]) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Info: (20261110 - Luphia) 隱私模式或空間不足：只是無法在重新整理後續傳
  }
};

export const listUnfinished = (roomId: string): IUnfinishedUpload[] => readAll().filter(e => e.roomId === roomId);

export const saveUnfinished = (entry: Omit<IUnfinishedUpload, 'savedAt'>) => {
  writeAll([...readAll().filter(e => e.uploadId !== entry.uploadId), { ...entry, savedAt: Date.now() }]);
};

export const removeUnfinished = (uploadId: string) => {
  const all = readAll();
  if (all.some(e => e.uploadId === uploadId)) writeAll(all.filter(e => e.uploadId !== uploadId));
};

export const storedCount = (entry: Pick<IUnfinishedUpload, 'stored'>) => entry.stored.filter(Boolean).length;

// Info: (20261110 - Luphia) 選回的檔案是否為同一個 (名稱、大小、修改時間)
export const isSameFile = (entry: IUnfinishedUpload, file: File) =>
  file.name === entry.name && file.size === entry.size && file.lastModified === entry.lastModified;

/**
 * Info: (20261110 - Luphia)
 * 正在上傳的分頁持有 Web Lock (分頁關閉時自動釋放)，其他分頁據此判斷是否真的「未完成」
 * 不支援 Web Locks (非 HTTPS) 時改看最後更新時間：40 秒內有更新視為仍在上傳
 */
const LOCK_PREFIX = 'drophere-upload-';
const ACTIVE_WINDOW_MS = 40 * 1000;
const hasLocks = () => typeof navigator !== 'undefined' && !!navigator.locks;

export const holdUploadLock = (uploadId: string): (() => void) => {
  if (!hasLocks()) return () => undefined;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  navigator.locks.request(`${LOCK_PREFIX}${uploadId}`, () => held).catch(() => undefined);
  return () => release();
};

export const touchUnfinished = (uploadId: string) => {
  const all = readAll();
  const entry = all.find(e => e.uploadId === uploadId);
  if (!entry) return;
  entry.savedAt = Date.now();
  writeAll(all);
};

// Info: (20261110 - Luphia) 沒有任何分頁在上傳的未完成項目
export const listResumable = async (roomId: string): Promise<IUnfinishedUpload[]> => {
  const entries = listUnfinished(roomId);
  if (entries.length === 0) return entries;
  if (!hasLocks()) return entries.filter(e => Date.now() - e.savedAt > ACTIVE_WINDOW_MS);
  try {
    const state = await navigator.locks.query();
    const held = new Set((state.held ?? []).map(lock => lock.name));
    return entries.filter(e => !held.has(`${LOCK_PREFIX}${e.uploadId}`));
  } catch {
    return entries;
  }
};
