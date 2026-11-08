import { useCallback, useRef, useState } from 'react';
import { uploadFile, UPLOAD_CANCELLED, type ILariaMetadata } from '@/lib/file_operator';
import { memberHeaders } from '@/lib/member';
import { ApiCode } from '@/lib/status';
import type { IRoomChat } from '@/lib/use_room_chat';
import type { IPathedFile } from '@/lib/folder_entries';

// Info: (20261105 - Luphia) crypto.randomUUID 僅限 HTTPS / localhost；getRandomValues 在一般 HTTP 也可用
const createUploadId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');

// Info: (20261108 - Luphia) 資料夾上傳時同時進行的檔案數
const FOLDER_CONCURRENCY = 3;
// Info: (20261108 - Luphia) 資料夾進度以千分比回報 (shardsDone / shardsTotal)
const FOLDER_SCALE = 1000;
const REPORT_INTERVAL_MS = 1000;
const MAX_PARTS = 12;

interface IUseRoomUploaderOptions {
  roomId: string;
  password: string | null;
  allowDownload: boolean;
  chat: IRoomChat;
  onError: (message: string) => void;
  // Info: (20261108 - Luphia) 資料夾上傳結束 (含失敗的檔案數)
  onFolderDone?: (folder: string, uploaded: number, failed: number) => void;
  // Info: (20261108 - Luphia) 使用者取消上傳後的結果 (removed：已刪除的已完成檔案數；kept：保留的檔案數)
  onCancelled?: (name: string, result: { kept: number; removed: number; failedToRemove: number }) => void;
}

export interface ICancelOptions {
  // Info: (20261108 - Luphia) 資料夾：保留已完成的檔案 (預設刪除，避免留下不完整的資料夾)
  keepFiles?: boolean;
}

interface IActiveUpload {
  controller: AbortController;
  keepFiles: boolean;
}

export interface IRoomUploader {
  upload: (entries: IPathedFile[]) => void;
  cancel: (uploadId: string, options?: ICancelOptions) => void;
  // Info: (20261108 - Luphia) 這個分頁正在進行、可以取消的上傳 (uploadId 或資料夾的 bundleId)
  active: ReadonlySet<string>;
  // Info: (20261108 - Luphia) 已按下取消、正在停止中的上傳
  cancelling: ReadonlySet<string>;
}

const isCancelled = (err: unknown) => err instanceof Error && err.message === UPLOAD_CANCELLED;

/**
 * Info: (20261106 - Luphia)
 * 在房間內上傳檔案：分片上傳、即時回報進度 (房間內的人可看到)、完成後寫入房間 metadata
 * Info: (20261108 - Luphia) 資料夾以「上傳包」回報整體進度，檔案保留相對路徑，同時上傳 3 個檔案
 * Info: (20261108 - Luphia) 可取消：中止進行中的分片並通知房間；資料夾可選擇保留或刪除已完成的檔案
 */
export function useRoomUploader({ roomId, password, allowDownload, chat, onError, onFolderDone, onCancelled }: IUseRoomUploaderOptions): IRoomUploader {
  const lastReportRef = useRef(new Map<string, number>());
  const activeRef = useRef(new Map<string, IActiveUpload>());
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());

  const begin = useCallback((id: string) => {
    const entry: IActiveUpload = { controller: new AbortController(), keepFiles: false };
    activeRef.current.set(id, entry);
    setActive(new Set(activeRef.current.keys()));
    return entry;
  }, []);
  const finish = useCallback((id: string) => {
    activeRef.current.delete(id);
    setActive(new Set(activeRef.current.keys()));
    setCancelling(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const cancel = useCallback((id: string, options: ICancelOptions = {}) => {
    const entry = activeRef.current.get(id);
    if (!entry || entry.controller.signal.aborted) return;
    entry.keepFiles = !!options.keepFiles;
    entry.controller.abort();
    setCancelling(prev => new Set(prev).add(id));
  }, []);

  const saveMetadata = useCallback(
    async (metadata: ILariaMetadata, uploadId: string, bundleId: string | null): Promise<string> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-upload-id': uploadId };
      if (bundleId) headers['x-upload-bundle'] = bundleId;
      const res = await fetch(`/api/v1/room/${roomId}`, {
        method: 'POST',
        headers: memberHeaders(headers, password),
        body: JSON.stringify(metadata),
      });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message || 'Upload could not be saved');
      // Info: (20261108 - Luphia) 伺服器可能因同名而改名，回傳實際儲存的檔名
      return data.payload?.filename ?? metadata.filename;
    },
    [password, roomId]
  );

  const deleteSaved = useCallback(
    async (names: string[]) => {
      let removed = 0;
      for (const name of names) {
        try {
          const res = await fetch(`/api/v1/room/${roomId}/files/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: memberHeaders({}, password),
          });
          if ((await res.json()).code === ApiCode.OK) removed++;
        } catch {
          // Info: (20261108 - Luphia) 個別失敗：以數量回報
        }
      }
      return removed;
    },
    [password, roomId]
  );

  // Info: (20261108 - Luphia) 上傳單一檔案並寫入 metadata；完成後回傳儲存的檔名
  const uploadToRoom = useCallback(
    (
      file: File,
      filename: string,
      uploadId: string,
      bundleId: string | null,
      signal: AbortSignal,
      onFraction: (fraction: number, shardsDone: number, shardsTotal: number) => void
    ) =>
      new Promise<string>((resolve, reject) => {
        uploadFile(
          file,
          {
            onShardProgress: (done, total) => onFraction(total ? done / total : 0, done, total),
            onSuccess: async (_cid: string, metadata?: ILariaMetadata) => {
              if (!metadata) return reject(new Error('Upload could not be saved'));
              if (signal.aborted) return reject(new Error(UPLOAD_CANCELLED));
              try {
                resolve(await saveMetadata(metadata, uploadId, bundleId));
              } catch (err) {
                reject(err);
              }
            },
            onError: error => reject(new Error(error)),
          },
          { allowDownload, filename, signal }
        );
      }),
    [allowDownload, saveMetadata]
  );

  const uploadOne = useCallback(
    async ({ file, path }: IPathedFile) => {
      const uploadId = createUploadId();
      const { controller } = begin(uploadId);
      let shardsTotal = 0;
      const report = (status: 'uploading' | 'failed' | 'cancelled', shardsDone: number) =>
        chat.reportUpload({ uploadId, filename: path, size: file.size, mimeType: file.type, shardsDone, shardsTotal, status });
      try {
        await uploadToRoom(file, path, uploadId, null, controller.signal, (_fraction, done, total) => {
          shardsTotal = total;
          const now = Date.now();
          const last = lastReportRef.current.get(uploadId) ?? 0;
          if (done === 0 || done === total || now - last >= REPORT_INTERVAL_MS) {
            lastReportRef.current.set(uploadId, now);
            report('uploading', done);
          }
        });
      } catch (err) {
        if (isCancelled(err)) {
          report('cancelled', 0);
          onCancelled?.(path, { kept: 0, removed: 0, failedToRemove: 0 });
        } else {
          report('failed', 0);
          onError(`${path}: ${err instanceof Error ? err.message : 'upload failed'}`);
        }
      } finally {
        lastReportRef.current.delete(uploadId);
        finish(uploadId);
      }
    },
    [begin, chat, finish, onCancelled, onError, uploadToRoom]
  );

  /**
   * Info: (20261108 - Luphia)
   * 上傳整個資料夾 (一個上傳包)：所有檔案路徑都在 folder/ 之下
   */
  const uploadFolder = useCallback(
    async (folder: string, entries: IPathedFile[]) => {
      const bundleId = createUploadId();
      const job = begin(bundleId);
      const { signal } = job.controller;
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0) || 1;
      const fractions = new Array<number>(entries.length).fill(0);
      const finished = new Array<boolean>(entries.length).fill(false);
      const saved: string[] = [];
      // Info: (20261108 - Luphia) 第一層項目 (子資料夾或檔案) 的檔案數
      const partOf = (path: string) => path.slice(folder.length + 1).split('/')[0];
      const partNames = [...new Set(entries.map(e => partOf(e.path)))];
      const partIsFolder = new Set(entries.filter(e => e.path.slice(folder.length + 1).includes('/')).map(e => partOf(e.path)));
      const partMembers = new Map(partNames.map(name => [name, entries.map((e, i) => (partOf(e.path) === name ? i : -1)).filter(i => i >= 0)]));
      let filesDone = 0;
      let failed = 0;
      let lastReport = 0;

      const report = (status: 'uploading' | 'failed' | 'complete' | 'cancelled') => {
        const bytesDone = entries.reduce((sum, e, i) => sum + e.file.size * fractions[i], 0);
        const parts = partNames
          .map(name => {
            const members = partMembers.get(name) ?? [];
            return { name: partIsFolder.has(name) ? `${name}/` : name, done: members.filter(i => finished[i]).length, total: members.length };
          })
          .sort((a, b) => b.total - a.total)
          .slice(0, MAX_PARTS);
        return chat.reportUpload({
          uploadId: bundleId,
          filename: folder,
          size: totalBytes,
          mimeType: '',
          shardsDone: Math.min(FOLDER_SCALE, Math.floor((bytesDone / totalBytes) * FOLDER_SCALE)),
          shardsTotal: FOLDER_SCALE,
          status,
          kind: 'folder',
          filesDone,
          filesTotal: entries.length,
          parts,
        });
      };
      // Info: (20261108 - Luphia) 節流期間的最後一次變化也要送出 (檔案完成後若沒有新的進度，原本會一直停在舊狀態)
      let trailing: ReturnType<typeof setTimeout> | null = null;
      let ended = false;
      const maybeReport = () => {
        if (ended || signal.aborted) return;
        const now = Date.now();
        if (now - lastReport >= REPORT_INTERVAL_MS) {
          lastReport = now;
          report('uploading');
        } else if (!trailing) {
          trailing = setTimeout(() => {
            trailing = null;
            if (ended || signal.aborted) return;
            lastReport = Date.now();
            report('uploading');
          }, REPORT_INTERVAL_MS - (now - lastReport));
        }
      };

      try {
        lastReport = Date.now();
        await report('uploading');
        let cursor = 0;
        const worker = async () => {
          while (cursor < entries.length && !signal.aborted) {
            const index = cursor++;
            const entry = entries[index];
            try {
              saved.push(
                await uploadToRoom(entry.file, entry.path, `${bundleId}f${index}`, bundleId, signal, fraction => {
                  fractions[index] = fraction;
                  maybeReport();
                })
              );
              filesDone++;
              finished[index] = true;
            } catch (err) {
              if (isCancelled(err)) break;
              failed++;
              finished[index] = true;
              console.warn(`[Upload] ${entry.path} failed:`, err instanceof Error ? err.message : err);
            } finally {
              if (finished[index]) fractions[index] = 1;
              maybeReport();
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(FOLDER_CONCURRENCY, entries.length) }, worker));
        ended = true;
        if (trailing) clearTimeout(trailing);

        if (signal.aborted) {
          // Info: (20261108 - Luphia) 取消：先刪除已完成的檔案 (除非選擇保留)，再通知房間，避免短暫出現不完整的資料夾
          const removed = job.keepFiles ? 0 : await deleteSaved(saved);
          await report('cancelled');
          onCancelled?.(folder, {
            kept: job.keepFiles ? saved.length : 0,
            removed,
            failedToRemove: job.keepFiles ? 0 : saved.length - removed,
          });
          return;
        }
        await report(filesDone > 0 ? 'complete' : 'failed');
        if (failed > 0) onError(`${folder}: ${failed} of ${entries.length} files could not be uploaded`);
        onFolderDone?.(folder, filesDone, failed);
      } finally {
        ended = true;
        if (trailing) clearTimeout(trailing);
        finish(bundleId);
      }
    },
    [begin, chat, deleteSaved, finish, onCancelled, onError, onFolderDone, uploadToRoom]
  );

  /**
   * Info: (20261108 - Luphia)
   * entries：路徑含 / 的依第一層資料夾分成上傳包，其餘為單一檔案
   */
  const upload = useCallback(
    (entries: IPathedFile[]) => {
      const folders = new Map<string, IPathedFile[]>();
      entries.forEach(entry => {
        const slash = entry.path.indexOf('/');
        if (slash < 0) {
          uploadOne(entry);
          return;
        }
        const folder = entry.path.slice(0, slash);
        folders.set(folder, [...(folders.get(folder) ?? []), entry]);
      });
      folders.forEach((list, folder) => {
        uploadFolder(folder, list);
      });
    },
    [uploadFolder, uploadOne]
  );

  return { upload, cancel, active, cancelling };
}
