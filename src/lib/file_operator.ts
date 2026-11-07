import { ReedSolomonErasure } from '@/lib/reed_solomon_erasure';

export interface IUploadCallbacks {
  onProgress?: (percentage: number) => void;
  onSuccess?: (hash: string, metadata?: ILariaMetadata) => void;
  onError?: (error: string) => void;
  // Info: (20261105 - Luphia) 每存入一個分片回報一次 (done / total)，供房間即時顯示上傳進度
  onShardProgress?: (done: number, total: number) => void;
}

export interface IUploadOptions {
  // Info: (20261105 - Luphia) 是否允許接收者下載 (預設允許)
  allowDownload?: boolean;
}

export interface IMissingShard {
  stripe: number;
  index: number;
}

export interface IShardStats {
  total: number;
  missingData: number;
  missingParity: number;
  missing: IMissingShard[];
  // Info: (20261105 - Luphia) 是否已用同位分片補回遺失的資料分片
  reconstructed: boolean;
}

export interface IDownloadCallbacks {
  onProgress?: (percentage: number) => void;
  onSuccess?: (file: Blob, filename: string) => void;
  onError?: (error: string) => void;
  // Info: (20261105 - Luphia) 回報分片取得狀況，供檔案瀏覽器顯示儲存健康度
  onShardStats?: (stats: IShardStats) => void;
}

/**
 * Info: (20251028 - Luphia) Download metadata interface
 */
export interface ILariaMetadata {
  filename: string;
  originalFileSize: number;
  mimeType: string;
  shards: string[];
  algorithm: {
    k: number;
    m: number;
    shardSize: number;
    // Info: (20261105 - Luphia) 'reed-solomon' = 同位分片為真實編碼；未設定 = 舊版上傳 (同位分片為 0，無法重建)
    parity?: 'reed-solomon';
  };
  // Info: (20261105 - Luphia) 未設定視為允許下載
  allowDownload?: boolean;
  uploadedAt?: number;
  repairedAt?: number;
  // Info: (20261106 - Luphia) 上傳者代號 (伺服器依瀏覽器身分產生，每個房間不同)
  uploaderId?: string | null;
  // Info: (20261108 - Luphia) 上傳者的 CAFECA 代稱 (由伺服器依登入身分填入)
  uploaderName?: string | null;
}

// Info: (20251028 - Luphia) Shared constants with server-side logic
const DATA_SHARDS = 5;
const PARITY_SHARDS = 3;
const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;
const SHARD_SIZE = 4 * 1024 * 1024; // 4MB
const DATA_STRIPE_SIZE = DATA_SHARDS * SHARD_SIZE; // 20MB

// Info: (20261105 - Luphia) 與伺服器端 Laria 共用的 Reed-Solomon (8, 5) 實作
const rse = new ReedSolomonErasure(DATA_SHARDS, PARITY_SHARDS);

export const isParityProtected = (metadata: ILariaMetadata): boolean => metadata.algorithm?.parity === 'reed-solomon';

export const isDownloadAllowed = (metadata: ILariaMetadata): boolean => metadata.allowDownload !== false;

/**
 * Info: (20251028 - Luphia) Helper to upload a single Blob to the backend
 */
const uploadSingleFile = (file: Blob, fileName: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file, fileName);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/file', true);

    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const response = JSON.parse(xhr.responseText);
          resolve(response.payload.hash);
        } catch {
          reject(new Error('Invalid response'));
        }
      } else {
        reject(new Error('Upload failed'));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error'));
    };

    xhr.send(formData);
  });
};

/**
 * Info: (20251028 - Luphia) Helper to download a single file by CID from the backend
 */
const downloadSingleFile = (cid: string): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Info: (20260113 - Luphia) Using the existing GET endpoint pattern
    xhr.open('GET', `/api/v1/file/${cid}`, true);
    xhr.responseType = 'blob';

    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(xhr.response);
      } else {
        reject(new Error(`Download failed: ${xhr.status}`));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error'));
    };

    xhr.send();
  });
};

/**
 * Info: (20261105 - Luphia)
 * 下載一個條帶的 8 個分片 (平行)；取不到的分片為 null
 * 分片大小不符視同遺失，避免錯誤資料進入重建
 */
const fetchStripe = async (
  metadata: ILariaMetadata,
  stripeIndex: number,
  onShardDone: () => void
): Promise<(Uint8Array | null)[]> => {
  const cids = metadata.shards.slice(stripeIndex * TOTAL_SHARDS, (stripeIndex + 1) * TOTAL_SHARDS);
  const shards: (Uint8Array | null)[] = new Array(TOTAL_SHARDS).fill(null);
  await Promise.all(
    cids.map(async (cid, i) => {
      try {
        const buffer = new Uint8Array(await (await downloadSingleFile(cid)).arrayBuffer());
        if (buffer.length === SHARD_SIZE) shards[i] = buffer;
      } catch {
        // Info: (20260113 - Luphia) Missing shard
      } finally {
        onShardDone();
      }
    })
  );
  return shards;
};

const missingIndices = (shards: (Uint8Array | null)[]): number[] =>
  shards.reduce<number[]>((acc, shard, i) => (shard ? acc : [...acc, i]), []);

/**
 * Info: (20251028 - Luphia) Core Upload Function using Laria split logic
 */
export const uploadFile = async (file: File, callbacks: IUploadCallbacks, options: IUploadOptions = {}) => {
  try {
    const originalFileSize = file.size;
    const totalStripes = Math.ceil(originalFileSize / DATA_STRIPE_SIZE);
    const totalUploads = totalStripes * TOTAL_SHARDS;
    let uploaded = 0;

    const shardCids: string[] = [];
    if (callbacks.onShardProgress) callbacks.onShardProgress(0, totalUploads);

    for (let stripeIndex = 0; stripeIndex < totalStripes; stripeIndex++) {
      const start = stripeIndex * DATA_STRIPE_SIZE;
      const end = Math.min(start + DATA_STRIPE_SIZE, originalFileSize);

      // Info: (20261105 - Luphia) 最後一條帶以 0 填滿 20MB
      const dataStripe = new Uint8Array(DATA_STRIPE_SIZE);
      dataStripe.set(new Uint8Array(await file.slice(start, end).arrayBuffer()));

      const shards: Uint8Array[] = [
        ...Array.from({ length: DATA_SHARDS }, (_, i) => dataStripe.subarray(i * SHARD_SIZE, (i + 1) * SHARD_SIZE)),
        ...Array.from({ length: PARITY_SHARDS }, () => new Uint8Array(SHARD_SIZE)),
      ];

      // Info: (20261105 - Luphia) 真實 Reed-Solomon 編碼，任意 5 個分片即可還原
      rse.encode(shards);

      const cids = await Promise.all(
        shards.map(async (shard, i) => {
          // Info: (20251028 - Luphia) Fix for Uint8Array not assignable to BlobPart issue by casting
          const shardBlob = new Blob([shard as unknown as BlobPart]);
          const cid = await uploadSingleFile(shardBlob, `${file.name}.part${stripeIndex * TOTAL_SHARDS + i}`);
          uploaded++;
          if (callbacks.onProgress) callbacks.onProgress(Math.min((uploaded / totalUploads) * 100, 99));
          if (callbacks.onShardProgress) callbacks.onShardProgress(uploaded, totalUploads);
          return cid;
        })
      );
      shardCids.push(...cids);
    }

    const metadata: ILariaMetadata = {
      filename: file.name,
      originalFileSize: file.size,
      mimeType: file.type,
      shards: shardCids,
      algorithm: {
        k: DATA_SHARDS,
        m: PARITY_SHARDS,
        shardSize: SHARD_SIZE,
        parity: 'reed-solomon',
      },
      allowDownload: options.allowDownload !== false,
      uploadedAt: Date.now(),
    };

    const metadataBlob = new Blob([JSON.stringify(metadata)], { type: 'application/json' });
    const metadataCid = await uploadSingleFile(metadataBlob, `${file.name}.meta.json`);

    if (callbacks.onProgress) callbacks.onProgress(100);
    if (callbacks.onSuccess) callbacks.onSuccess(metadataCid, metadata);
  } catch (err) {
    if (callbacks.onError) {
      callbacks.onError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return {
    abort: () => {
      console.warn('Abort not fully implemented for split upload');
    },
  };
};

/**
 * Info: (20251028 - Luphia) Type guard for Laria Metadata
 */
function isLariaMetadata(obj: unknown): obj is ILariaMetadata {
  const meta = obj as ILariaMetadata;
  return !!meta && typeof meta.filename === 'string' && typeof meta.originalFileSize === 'number' && Array.isArray(meta.shards);
}

/**
 * Info: (20251028 - Luphia) Core Download Function
 * - Fetches CID content.
 * - Checks if it's Laria metadata.
 * - If yes, downloads shards and reconstructs.
 * - If no, treats as direct file download.
 */
export const downloadFile = async (cid: string, callbacks: IDownloadCallbacks) => {
  try {
    if (callbacks.onProgress) callbacks.onProgress(1); // Started

    // Info: (20251028 - Luphia) 1. Fetch the initial file/metadata
    const initialBlob = await downloadSingleFile(cid);

    let metadata: ILariaMetadata | null = null;

    // Info: (20260113 - Luphia) Optimization: Only check for metadata if file is reasonably small (<10MB)
    if (initialBlob.size < 10 * 1024 * 1024) {
      try {
        const parsed = JSON.parse(await initialBlob.text());
        if (isLariaMetadata(parsed)) metadata = parsed;
      } catch {
        // Info: (20260113 - Luphia) Not JSON, so it's a regular file
      }
    }

    if (metadata) {
      await downloadFromMetadata(metadata, callbacks);
    } else {
      // Info: (20260113 - Luphia) --- Direct Download ---
      if (callbacks.onProgress) callbacks.onProgress(100);
      if (callbacks.onSuccess) callbacks.onSuccess(initialBlob, `file_${cid}`);
    }
  } catch (err) {
    if (callbacks.onError) {
      callbacks.onError(err instanceof Error ? err.message : 'Download failed');
    }
  }
};

/**
 * Info: (20260113 - Luphia) Download file from Laria Metadata
 * Info: (20261105 - Luphia) 遺失 1-3 個分片時以 Reed-Solomon 補回資料分片
 */
export const downloadFromMetadata = async (metadata: ILariaMetadata, callbacks: IDownloadCallbacks) => {
  try {
    const { originalFileSize, shards: shardCids, filename } = metadata;
    const totalStripes = Math.ceil(shardCids.length / TOTAL_SHARDS);
    const protectedByParity = isParityProtected(metadata);

    const stats: IShardStats = { total: shardCids.length, missingData: 0, missingParity: 0, missing: [], reconstructed: false };
    const output = new Uint8Array(totalStripes * DATA_STRIPE_SIZE);
    let fetched = 0;

    for (let stripeIdx = 0; stripeIdx < totalStripes; stripeIdx++) {
      const shards = await fetchStripe(metadata, stripeIdx, () => {
        fetched++;
        if (callbacks.onProgress) callbacks.onProgress((fetched / shardCids.length) * 95);
      });

      const missing = missingIndices(shards);
      missing.forEach(index => {
        stats.missing.push({ stripe: stripeIdx, index });
        if (index < DATA_SHARDS) stats.missingData++;
        else stats.missingParity++;
      });

      const missingData = missing.filter(i => i < DATA_SHARDS).length;
      if (missingData > 0) {
        if (!protectedByParity) {
          throw new Error(
            `Stripe ${stripeIdx + 1}: ${missingData} data shard(s) missing. This file was uploaded before parity protection and cannot be rebuilt.`
          );
        }
        if (missing.length > PARITY_SHARDS) {
          throw new Error(
            `Stripe ${stripeIdx + 1}: ${missing.length} of ${TOTAL_SHARDS} shards missing. At least ${DATA_SHARDS} are needed to rebuild the file.`
          );
        }
        // Info: (20261105 - Luphia) 以同位分片補回資料分片
        rse.reconstruct(shards, true);
        stats.reconstructed = true;
      }

      for (let i = 0; i < DATA_SHARDS; i++) {
        output.set(shards[i] as Uint8Array, stripeIdx * DATA_STRIPE_SIZE + i * SHARD_SIZE);
      }
    }

    // Info: (20260113 - Luphia) Truncate to original size
    const finalBlob = new Blob([output.subarray(0, originalFileSize) as unknown as BlobPart], {
      type: metadata.mimeType || 'application/octet-stream',
    });

    if (callbacks.onShardStats) callbacks.onShardStats(stats);
    if (callbacks.onProgress) callbacks.onProgress(100);
    if (callbacks.onSuccess) callbacks.onSuccess(finalBlob, filename);
  } catch (err) {
    if (callbacks.onError) {
      callbacks.onError(err instanceof Error ? err.message : 'Download failed');
    }
  }
};

export interface IRepairResult {
  metadata: ILariaMetadata;
  repaired: IMissingShard[];
}

/**
 * Info: (20261105 - Luphia)
 * 修復：重建遺失的分片 (資料與同位) 並重新存入儲存網路，回傳更新後的 metadata
 * - 每個條帶最多可修復 3 個遺失分片
 * - 分片以內容定址，重建後的內容與原始分片相同
 */
export const repairFile = async (
  metadata: ILariaMetadata,
  onProgress?: (percentage: number) => void
): Promise<IRepairResult> => {
  if (!isParityProtected(metadata)) {
    throw new Error('This file was uploaded before parity protection and cannot be repaired. Upload it again to protect it.');
  }

  const shardCids = [...metadata.shards];
  const totalStripes = Math.ceil(shardCids.length / TOTAL_SHARDS);
  const repaired: IMissingShard[] = [];

  for (let stripeIdx = 0; stripeIdx < totalStripes; stripeIdx++) {
    const shards = await fetchStripe(metadata, stripeIdx, () => undefined);
    const missing = missingIndices(shards);

    if (missing.length > PARITY_SHARDS) {
      throw new Error(`Stripe ${stripeIdx + 1}: ${missing.length} shards missing, more than the ${PARITY_SHARDS} that can be rebuilt.`);
    }

    if (missing.length > 0) {
      const rebuilt = rse.reconstruct(shards);
      await Promise.all(
        missing.map(async index => {
          const position = stripeIdx * TOTAL_SHARDS + index;
          const blob = new Blob([rebuilt[index] as unknown as BlobPart]);
          shardCids[position] = await uploadSingleFile(blob, `${metadata.filename}.part${position}`);
          repaired.push({ stripe: stripeIdx, index });
        })
      );
    }

    if (onProgress) onProgress(((stripeIdx + 1) / totalStripes) * 100);
  }

  return {
    metadata: repaired.length > 0 ? { ...metadata, shards: shardCids, repairedAt: Date.now() } : metadata,
    repaired,
  };
};
