import { downloadZip } from 'client-zip';
import { downloadFromMetadata, isDownloadAllowed, type ILariaMetadata } from '@/lib/file_operator';
import { guessMimeType } from '@/lib/file_types';
import { baseName, parentOf } from '@/lib/folder_tree';

/**
 * Info: (20261108 - Luphia)
 * 整個資料夾下載為 .zip：在瀏覽器中逐一取回並還原檔案，邊下載邊打包 (不壓縮，伺服器不經手)
 * - 支援 showSaveFilePicker 的瀏覽器 (Chrome / Edge)：直接寫入磁碟，不受記憶體限制
 * - 其他瀏覽器：在記憶體中組成 .zip 後下載
 * - 上傳者關閉下載的檔案不會放進 .zip
 */

type TSaveTarget = { kind: 'stream'; writable: WritableStream<Uint8Array> } | { kind: 'blob' } | { kind: 'cancelled' };

interface ISaveFilePickerWindow {
  showSaveFilePicker?: (options: { suggestedName: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{
    createWritable: () => Promise<WritableStream<Uint8Array>>;
  }>;
}

// Info: (20261108 - Luphia) 必須在點擊事件中「第一個」呼叫，否則瀏覽器會拒絕開啟儲存對話框
export async function chooseZipTarget(zipName: string): Promise<TSaveTarget> {
  const picker = (window as unknown as ISaveFilePickerWindow).showSaveFilePicker;
  if (!picker) return { kind: 'blob' };
  try {
    const handle = await picker({ suggestedName: zipName, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
    return { kind: 'stream', writable: await handle.createWritable() };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'blob' };
  }
}

const fetchFile = (metadata: ILariaMetadata): Promise<Blob> =>
  new Promise((resolve, reject) => {
    downloadFromMetadata(metadata, {
      onSuccess: raw => resolve(new Blob([raw], { type: guessMimeType(metadata.filename, metadata.mimeType) })),
      onError: error => reject(new Error(error)),
    });
  });

export interface IZipProgress {
  done: number;
  total: number;
  failed: number;
}

/**
 * Info: (20261108 - Luphia)
 * folder：要下載的資料夾路徑；.zip 內保留該資料夾名稱與其下的結構
 */
export async function downloadFolderZip(
  folder: string,
  files: ILariaMetadata[],
  target: Exclude<TSaveTarget, { kind: 'cancelled' }>,
  onProgress: (progress: IZipProgress) => void
): Promise<{ skipped: number; failed: number; blob?: Blob }> {
  const included = files.filter(isDownloadAllowed);
  const skipped = files.length - included.length;
  const strip = parentOf(folder) ? `${parentOf(folder)}/` : '';
  const progress: IZipProgress = { done: 0, total: included.length, failed: 0 };
  onProgress({ ...progress });

  async function* entries() {
    for (const metadata of included) {
      try {
        const blob = await fetchFile(metadata);
        yield { name: metadata.filename.slice(strip.length), input: blob, lastModified: metadata.uploadedAt ? new Date(metadata.uploadedAt) : new Date() };
      } catch (err) {
        progress.failed += 1;
        console.warn(`[Zip] ${metadata.filename} could not be downloaded:`, err instanceof Error ? err.message : err);
      }
      progress.done += 1;
      onProgress({ ...progress });
    }
  }

  const response = downloadZip(entries());
  if (target.kind === 'stream' && response.body) {
    await response.body.pipeTo(target.writable);
    return { skipped, failed: progress.failed };
  }
  return { skipped, failed: progress.failed, blob: await response.blob() };
}

export const zipNameOf = (folder: string) => `${baseName(folder)}.zip`;
