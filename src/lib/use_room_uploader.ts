import { useCallback, useEffect, useRef, useState } from 'react';
import { shardCountFor, uploadFile, UPLOAD_CANCELLED, type ILariaMetadata } from '@/lib/file_operator';
import { memberHeaders } from '@/lib/member';
import { ApiCode } from '@/lib/status';
import type { IRoomChat, IUploadReportInput } from '@/lib/use_room_chat';
import type { IPathedFile } from '@/lib/folder_entries';
import { holdUploadLock, isSameFile, listResumable, listUnfinished, removeUnfinished, saveUnfinished, touchUnfinished, type IUnfinishedUpload } from '@/lib/upload_resume';

// Info: (20261105 - Luphia) crypto.randomUUID 僅限 HTTPS / localhost；getRandomValues 在一般 HTTP 也可用
const createUploadId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');

// Info: (20261108 - Luphia) 資料夾上傳時同時進行的檔案數
const FOLDER_CONCURRENCY = 3;
// Info: (20261108 - Luphia) 資料夾進度以千分比回報 (shardsDone / shardsTotal)
const FOLDER_SCALE = 1000;
const REPORT_INTERVAL_MS = 1000;
// Info: (20261110 - Luphia) 沒有新進度時也定期回報，讓伺服器知道分頁仍在上傳 (伺服器 60 秒沒收到回報會標為中斷)
const HEARTBEAT_MS = 15 * 1000;
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
  // Info: (20261110 - Luphia) 自動重試仍失敗、上傳暫停
  onPaused?: (name: string, reason: string) => void;
}

export interface ICancelOptions {
  // Info: (20261108 - Luphia) 資料夾：保留已完成的檔案 (預設刪除，避免留下不完整的資料夾)
  keepFiles?: boolean;
}

export interface IRoomUploader {
  upload: (entries: IPathedFile[]) => void;
  cancel: (uploadId: string, options?: ICancelOptions) => void;
  // Info: (20261110 - Luphia) 續傳暫停中的上傳 (同一個分頁)
  resume: (uploadId: string) => void;
  // Info: (20261108 - Luphia) 這個分頁正在進行、可以取消的上傳 (uploadId 或資料夾的 bundleId)
  active: ReadonlySet<string>;
  // Info: (20261108 - Luphia) 已按下取消、正在停止中的上傳
  cancelling: ReadonlySet<string>;
  // Info: (20261110 - Luphia) 暫停中的上傳與原因
  paused: ReadonlyMap<string, string>;
  // Info: (20261110 - Luphia) 先前分頁留下、尚未完成的上傳 (重新選擇同一個檔案即可續傳)
  unfinished: IUnfinishedUpload[];
  resumeUnfinished: (uploadId: string, file: File) => boolean;
  discardUnfinished: (uploadId: string) => void;
}

interface IJob {
  id: string;
  controller: AbortController;
  keepFiles: boolean;
  paused: boolean;
  running: boolean;
  run: () => Promise<void>;
  heartbeat: () => void;
  // Info: (20261110 - Luphia) 暫停中被取消：直接收尾 (沒有進行中的請求可以中止)
  finalizeCancel: () => Promise<void>;
}

class FatalError extends Error {}

const isCancelled = (err: unknown) => err instanceof Error && err.message === UPLOAD_CANCELLED;
const errorText = (err: unknown) => (err instanceof Error ? err.message : 'upload failed');

/**
 * Info: (20261106 - Luphia)
 * 在房間內上傳檔案：分片上傳、即時回報進度 (房間內的人可看到)、完成後寫入房間 metadata
 * Info: (20261108 - Luphia) 資料夾以「上傳包」回報整體進度，檔案保留相對路徑，同時上傳 3 個檔案
 * Info: (20261108 - Luphia) 可取消：中止進行中的分片並通知房間；資料夾可選擇保留或刪除已完成的檔案
 * Info: (20261110 - Luphia) 分片自動重試；仍失敗時暫停 (保留已存好的分片)，可手動或在網路恢復時續傳；
 *   單一檔案的進度另存於瀏覽器，重新整理後選回同一個檔案即可續傳
 */
export function useRoomUploader({
  roomId,
  password,
  allowDownload,
  chat,
  onError,
  onFolderDone,
  onCancelled,
  onPaused,
}: IUseRoomUploaderOptions): IRoomUploader {
  const jobsRef = useRef(new Map<string, IJob>());
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const [paused, setPaused] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [unfinished, setUnfinished] = useState<IUnfinishedUpload[]>([]);

  const refreshUnfinished = useCallback(async () => {
    const entries = (await listResumable(roomId)).filter(e => !jobsRef.current.has(e.uploadId));
    setUnfinished(prev =>
      prev.length === entries.length && prev.every((e, i) => e.uploadId === entries[i].uploadId && e.savedAt === entries[i].savedAt) ? prev : entries
    );
  }, [roomId]);
  useEffect(() => {
    // Info: (20261110 - Luphia) localStorage 只能在瀏覽器讀取，延後到掛載後；之後定期檢查 (其他分頁關閉後才會出現)
    const first = setTimeout(refreshUnfinished, 0);
    const timer = setInterval(refreshUnfinished, 10 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refreshUnfinished]);

  const syncActive = useCallback(() => setActive(new Set(jobsRef.current.keys())), []);
  const setPausedReason = useCallback((id: string, reason: string | null) => {
    setPaused(prev => {
      if (reason === null && !prev.has(id)) return prev;
      const next = new Map(prev);
      if (reason === null) next.delete(id);
      else next.set(id, reason);
      return next;
    });
  }, []);
  const finish = useCallback(
    (id: string) => {
      jobsRef.current.delete(id);
      syncActive();
      setPausedReason(id, null);
      setCancelling(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [setPausedReason, syncActive]
  );

  const startJob = useCallback(
    (job: IJob) => {
      jobsRef.current.set(job.id, job);
      syncActive();
      job.running = true;
      job.run().finally(() => {
        job.running = false;
      });
    },
    [syncActive]
  );

  const cancel = useCallback((id: string, options: ICancelOptions = {}) => {
    const job = jobsRef.current.get(id);
    if (!job || job.controller.signal.aborted) return;
    job.keepFiles = !!options.keepFiles;
    job.controller.abort();
    setCancelling(prev => new Set(prev).add(id));
    if (job.paused && !job.running) job.finalizeCancel();
  }, []);

  const resume = useCallback(
    (id: string) => {
      const job = jobsRef.current.get(id);
      if (!job || !job.paused || job.running || job.controller.signal.aborted) return;
      job.paused = false;
      job.controller = new AbortController();
      setPausedReason(id, null);
      job.running = true;
      job.run().finally(() => {
        job.running = false;
      });
    },
    [setPausedReason]
  );

  // Info: (20261110 - Luphia) 心跳：分頁仍在上傳時定期回報；網路恢復時自動續傳暫停的上傳
  useEffect(() => {
    const timer = setInterval(() => jobsRef.current.forEach(job => !job.paused && job.running && job.heartbeat()), HEARTBEAT_MS);
    const onOnline = () => jobsRef.current.forEach(job => job.paused && resume(job.id));
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [resume]);

  const saveMetadata = useCallback(
    async (metadata: ILariaMetadata, uploadId: string, bundleId: string | null): Promise<string> => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-upload-id': uploadId };
      if (bundleId) headers['x-upload-bundle'] = bundleId;
      const res = await fetch(`/api/v1/room/${roomId}`, {
        method: 'POST',
        headers: memberHeaders(headers, password),
        body: JSON.stringify(metadata),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`Saving failed (HTTP ${res.status})`);
      // Info: (20261110 - Luphia) 伺服器拒絕 (權限、檔名等)：重試也不會成功
      if (data.code !== ApiCode.OK) throw new FatalError(data.message || 'Upload could not be saved');
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
      stored: (string | null)[],
      handlers: {
        onBytes: (fraction: number) => void;
        onShards: (done: number, total: number) => void;
        onShardStored?: () => void;
        onRetry?: (attempt: number, reason: string) => void;
      }
    ) =>
      new Promise<string>((resolve, reject) => {
        uploadFile(
          file,
          {
            onBytes: (sent, total) => handlers.onBytes(total ? sent / total : 0),
            onShardProgress: handlers.onShards,
            onShardStored: (index, cid, total) => {
              if (stored.length !== total) stored.splice(0, stored.length, ...new Array<string | null>(total).fill(null));
              stored[index] = cid;
              handlers.onShardStored?.();
            },
            onRetry: handlers.onRetry,
            onSuccess: async (_cid: string, metadata?: ILariaMetadata) => {
              if (!metadata) return reject(new FatalError('Upload could not be saved'));
              if (signal.aborted) return reject(new Error(UPLOAD_CANCELLED));
              try {
                resolve(await saveMetadata(metadata, uploadId, bundleId));
              } catch (err) {
                reject(err);
              }
            },
            onError: (error, retryable) => reject(retryable || error === UPLOAD_CANCELLED ? new Error(error) : new FatalError(error)),
          },
          { allowDownload, filename, signal, storedShards: stored }
        );
      }),
    [allowDownload, saveMetadata]
  );

  /**
   * Info: (20261110 - Luphia)
   * 單一檔案上傳 (可續傳)：uploadId / stored 可沿用先前分頁留下的進度
   */
  const uploadOne = useCallback(
    ({ file, path }: IPathedFile, resumeFrom?: IUnfinishedUpload) => {
      const uploadId = resumeFrom?.uploadId ?? createUploadId();
      const shardsTotal = shardCountFor(file.size);
      const stored: (string | null)[] =
        resumeFrom && resumeFrom.stored.length === shardsTotal ? [...resumeFrom.stored] : new Array<string | null>(shardsTotal).fill(null);
      const state = { bytes: 0, shardsDone: stored.filter(Boolean).length, note: undefined as string | undefined, lastReport: 0 };
      const report = (status: IUploadReportInput['status']) =>
        chat.reportUpload({
          uploadId,
          filename: path,
          size: file.size,
          mimeType: file.type,
          shardsDone: status === 'uploading' || status === 'paused' ? state.shardsDone : 0,
          shardsTotal,
          bytesDone: Math.round(state.bytes * file.size),
          note: state.note,
          status,
        });
      const throttled = (force = false) => {
        const now = Date.now();
        if (force || now - state.lastReport >= REPORT_INTERVAL_MS) {
          state.lastReport = now;
          report('uploading');
        }
      };
      const persist = () =>
        saveUnfinished({ roomId, uploadId, path, name: file.name, size: file.size, lastModified: file.lastModified, mimeType: file.type, stored });

      // Info: (20261110 - Luphia) 這個分頁持有鎖直到上傳結束 (暫停中仍持有，可在此分頁續傳)
      const release = holdUploadLock(uploadId);
      const job: IJob = {
        id: uploadId,
        controller: new AbortController(),
        keepFiles: false,
        paused: false,
        running: false,
        heartbeat: () => {
          touchUnfinished(uploadId);
          report('uploading');
        },
        finalizeCancel: async () => {
          release();
          removeUnfinished(uploadId);
          await report('cancelled');
          onCancelled?.(path, { kept: 0, removed: 0, failedToRemove: 0 });
          finish(uploadId);
        },
        run: async () => {
          const { signal } = job.controller;
          state.note = undefined;
          throttled(true);
          try {
            await uploadToRoom(file, path, uploadId, null, signal, stored, {
              onBytes: fraction => {
                state.bytes = fraction;
                throttled();
              },
              onShards: done => {
                state.shardsDone = done;
                throttled(done === shardsTotal);
              },
              onShardStored: persist,
              onRetry: (attempt, reason) => {
                state.note = `${reason} · retrying (${attempt}/3)`;
                throttled(true);
              },
            });
            release();
            removeUnfinished(uploadId);
            finish(uploadId);
          } catch (err) {
            if (isCancelled(err) || signal.aborted) return job.finalizeCancel();
            if (err instanceof FatalError) {
              release();
              removeUnfinished(uploadId);
              await report('failed');
              onError(`${path}: ${err.message}`);
              finish(uploadId);
              return;
            }
            // Info: (20261110 - Luphia) 暫時性問題 (網路、儲存節點)：暫停並保留已存好的分片
            job.paused = true;
            state.note = errorText(err);
            persist();
            await report('paused');
            setPausedReason(uploadId, state.note);
            onPaused?.(path, state.note);
          }
        },
      };
      if (resumeFrom) removeUnfinished(uploadId);
      persist();
      startJob(job);
    },
    [chat, finish, onCancelled, onError, onPaused, roomId, setPausedReason, startJob, uploadToRoom]
  );

  /**
   * Info: (20261108 - Luphia)
   * 上傳整個資料夾 (一個上傳包)：所有檔案路徑都在 folder/ 之下
   * Info: (20261110 - Luphia) 重試仍失敗的檔案留待續傳；續傳只處理這些檔案 (已存好的分片沿用)
   */
  const uploadFolder = useCallback(
    (folder: string, entries: IPathedFile[]) => {
      const bundleId = createUploadId();
      const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0) || 1;
      const fractions = new Array<number>(entries.length).fill(0);
      const finished = new Array<boolean>(entries.length).fill(false);
      const stored = entries.map(() => [] as (string | null)[]);
      const saved: string[] = [];
      let pending = entries.map((_, i) => i);
      // Info: (20261108 - Luphia) 第一層項目 (子資料夾或檔案) 的檔案數
      const partOf = (path: string) => path.slice(folder.length + 1).split('/')[0];
      const partNames = [...new Set(entries.map(e => partOf(e.path)))];
      const partIsFolder = new Set(entries.filter(e => e.path.slice(folder.length + 1).includes('/')).map(e => partOf(e.path)));
      const partMembers = new Map(partNames.map(name => [name, entries.map((e, i) => (partOf(e.path) === name ? i : -1)).filter(i => i >= 0)]));
      let filesDone = 0;
      let failed = 0;
      let note: string | undefined;
      let lastReport = 0;

      const report = (status: IUploadReportInput['status']) => {
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
          bytesDone: Math.round(bytesDone),
          note,
          status,
          kind: 'folder',
          filesDone,
          filesTotal: entries.length,
          parts,
        });
      };

      const job: IJob = {
        id: bundleId,
        controller: new AbortController(),
        keepFiles: false,
        paused: false,
        running: false,
        heartbeat: () => report('uploading'),
        finalizeCancel: async () => {
          // Info: (20261108 - Luphia) 取消：先刪除已完成的檔案 (除非選擇保留)，再通知房間，避免短暫出現不完整的資料夾
          const removed = job.keepFiles ? 0 : await deleteSaved(saved);
          await report('cancelled');
          onCancelled?.(folder, {
            kept: job.keepFiles ? saved.length : 0,
            removed,
            failedToRemove: job.keepFiles ? 0 : saved.length - removed,
          });
          finish(bundleId);
        },
        run: async () => {
          const { signal } = job.controller;
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

          const queue = [...pending];
          const retryLater: number[] = [];
          let lastReason = '';
          // Info: (20261110 - Luphia) 有檔案重試仍失敗 (多半是網路中斷)：不再開始新的檔案，整包暫停
          let pausing = false;
          note = undefined;
          try {
            lastReport = Date.now();
            await report('uploading');
            const worker = async () => {
              while (queue.length > 0 && !signal.aborted && !pausing) {
                const index = queue.shift() as number;
                const entry = entries[index];
                try {
                  saved.push(
                    await uploadToRoom(entry.file, entry.path, `${bundleId}f${index}`, bundleId, signal, stored[index], {
                      onBytes: fraction => {
                        fractions[index] = fraction;
                        maybeReport();
                      },
                      onShards: () => undefined,
                      onRetry: (attempt, reason) => {
                        note = `${reason} · retrying (${attempt}/3)`;
                        maybeReport();
                      },
                    })
                  );
                  filesDone++;
                  finished[index] = true;
                } catch (err) {
                  if (isCancelled(err)) break;
                  if (err instanceof FatalError) {
                    failed++;
                    finished[index] = true;
                    console.warn(`[Upload] ${entry.path} failed:`, err.message);
                  } else {
                    retryLater.push(index);
                    lastReason = errorText(err);
                    pausing = true;
                  }
                } finally {
                  if (finished[index]) fractions[index] = 1;
                  maybeReport();
                }
              }
            };
            await Promise.all(Array.from({ length: Math.min(FOLDER_CONCURRENCY, queue.length) }, worker));
          } finally {
            ended = true;
            if (trailing) clearTimeout(trailing);
          }

          if (signal.aborted) return job.finalizeCancel();
          if (retryLater.length > 0) {
            pending = [...retryLater, ...queue].sort((a, b) => a - b);
            job.paused = true;
            note = `${lastReason} · ${pending.length} ${pending.length === 1 ? 'file' : 'files'} left`;
            await report('paused');
            setPausedReason(bundleId, note);
            onPaused?.(folder, note);
            return;
          }
          await report(filesDone > 0 ? 'complete' : 'failed');
          if (failed > 0) onError(`${folder}: ${failed} of ${entries.length} files could not be uploaded`);
          onFolderDone?.(folder, filesDone, failed);
          finish(bundleId);
        },
      };
      startJob(job);
    },
    [chat, deleteSaved, finish, onCancelled, onError, onFolderDone, onPaused, setPausedReason, startJob, uploadToRoom]
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
      folders.forEach((list, folder) => uploadFolder(folder, list));
    },
    [uploadFolder, uploadOne]
  );

  const resumeUnfinished = useCallback(
    (uploadId: string, file: File) => {
      const entry = listUnfinished(roomId).find(e => e.uploadId === uploadId);
      if (!entry || !isSameFile(entry, file)) return false;
      uploadOne({ file, path: entry.path }, entry);
      refreshUnfinished();
      return true;
    },
    [refreshUnfinished, roomId, uploadOne]
  );

  const discardUnfinished = useCallback(
    (uploadId: string) => {
      removeUnfinished(uploadId);
      refreshUnfinished();
    },
    [refreshUnfinished]
  );

  return { upload, cancel, resume, active, cancelling, paused, unfinished, resumeUnfinished, discardUnfinished };
}
