export interface IUploadCallbacks {
  onProgress?: (percentage: number) => void;
  onSuccess?: (hash: string, metadata?: ILariaMetadata) => void;
  onError?: (error: string) => void;
}

export interface IDownloadCallbacks {
  onProgress?: (percentage: number) => void;
  onSuccess?: (file: Blob, filename: string) => void;
  onError?: (error: string) => void;
}

// Info: (20251028 - Luphia) Shared constants with server-side logic
const DATA_SHARDS = 5;
const PARITY_SHARDS = 3;
const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;
const SHARD_SIZE = 4 * 1024 * 1024; // 4MB
const DATA_STRIPE_SIZE = DATA_SHARDS * SHARD_SIZE; // 20MB

// Info: (20251028 - Luphia) Mock Reed-Solomon Implementation
class ReedSolomonErasure {
  private dataShards: number;
  private parityShards: number;

  constructor(dataShards: number, parityShards: number) {
    this.dataShards = dataShards;
    this.parityShards = parityShards;
  }

  async encode(shards: Uint8Array[]): Promise<void> {
    // Info: (20251028 - Luphia) Mock encoding: parity shards are just zeros
    for (let i = this.dataShards; i < this.dataShards + this.parityShards; i++) {
      shards[i] = new Uint8Array(shards[0].length);
    }
  }

  async reconstruct(shards: (Uint8Array | null)[]): Promise<void> {
    /**
     * Info: (20251028 - Luphia) Mock reconstruction: just fill missing with zeros
     * In real RS, this would use the available shards to rebuild missing ones.
     */
    const len = shards.find(s => s !== null)?.length || SHARD_SIZE;
    for (let i = 0; i < shards.length; i++) {
      if (shards[i] === null) {
        shards[i] = new Uint8Array(len);
      }
    }
  }
}

const rse = new ReedSolomonErasure(DATA_SHARDS, PARITY_SHARDS);

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
 * Info: (20251028 - Luphia) Core Upload Function using Laria split logic
 */
export const uploadFile = async (file: File, callbacks: IUploadCallbacks) => {
  try {
    const originalFileSize = file.size;
    const totalStripes = Math.ceil(originalFileSize / DATA_STRIPE_SIZE);

    const totalUploadSize = totalStripes * TOTAL_SHARDS * SHARD_SIZE;
    let totalBytesUploaded = 0;

    const shardCids: string[] = [];

    for (let stripeIndex = 0; stripeIndex < totalStripes; stripeIndex++) {
      const start = stripeIndex * DATA_STRIPE_SIZE;
      const end = Math.min(start + DATA_STRIPE_SIZE, originalFileSize);

      const chunkBlob = file.slice(start, end);
      const chunkBuffer = new Uint8Array(await chunkBlob.arrayBuffer());

      let dataStripe: Uint8Array;
      if (chunkBuffer.length < DATA_STRIPE_SIZE) {
        dataStripe = new Uint8Array(DATA_STRIPE_SIZE);
        dataStripe.set(chunkBuffer);
      } else {
        dataStripe = chunkBuffer;
      }

      const shards: Uint8Array[] = [];
      for (let i = 0; i < DATA_SHARDS; i++) {
        const shardStart = i * SHARD_SIZE;
        const shardEnd = (i + 1) * SHARD_SIZE;
        shards.push(dataStripe.slice(shardStart, shardEnd));
      }
      for (let i = 0; i < PARITY_SHARDS; i++) {
        shards.push(new Uint8Array(SHARD_SIZE));
      }

      await rse.encode(shards);

      for (let i = 0; i < TOTAL_SHARDS; i++) {
        // Info: (20251028 - Luphia) Fix for Uint8Array not assignable to BlobPart issue by casting
        const shardBlob = new Blob([shards[i] as unknown as BlobPart]);
        const shardName = `${file.name}.part${stripeIndex * TOTAL_SHARDS + i}`;

        try {
          const cid = await uploadSingleFile(shardBlob, shardName);
          shardCids.push(cid);

          totalBytesUploaded += SHARD_SIZE;
          if (callbacks.onProgress) {
            const progress = (totalBytesUploaded / totalUploadSize) * 100;
            callbacks.onProgress(Math.min(progress, 99));
          }
        } catch (err) {
          throw err;
        }
      }
    }

    const metadata = {
      filename: file.name,
      originalFileSize: file.size,
      mimeType: file.type,
      shards: shardCids,
      algorithm: {
        k: DATA_SHARDS,
        m: PARITY_SHARDS,
        shardSize: SHARD_SIZE
      }
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
    abort: () => { console.warn('Abort not fully implemented for split upload'); }
  };
};

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
  };
}

/**
 * Info: (20251028 - Luphia) Type guard for Laria Metadata
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isLariaMetadata(obj: any): obj is ILariaMetadata {
  return obj
    && typeof obj.filename === 'string'
    && typeof obj.originalFileSize === 'number'
    && Array.isArray(obj.shards);
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

    let isMetadata = false;
    let metadata: ILariaMetadata | null = null;

    // Info: (20260113 - Luphia) Optimization: Only check for metadata if file is reasonably small (<10MB)
    // Info: (20260113 - Luphia) Large files are definitely not metadata JSONs.
    if (initialBlob.size < 10 * 1024 * 1024) {
      try {
        const initialText = await initialBlob.text();
        const parsed = JSON.parse(initialText);
        if (isLariaMetadata(parsed)) {
          isMetadata = true;
          metadata = parsed;
        }
      } catch {
        // Info: (20260113 - Luphia) Not JSON, so it's a regular file
        isMetadata = false;
      }
    }

    if (isMetadata && metadata) {
      await downloadFromMetadata(metadata, callbacks);
    } else {
      // Info: (20260113 - Luphia) --- Direct Download ---
      // Info: (20260113 - Luphia) It's just a file.
      if (callbacks.onProgress) callbacks.onProgress(100);
      // Info: (20260113 - Luphia) Try to extract filename from header if possible, or use CID default
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
 */
export const downloadFromMetadata = async (metadata: ILariaMetadata, callbacks: IDownloadCallbacks) => {
  try {
    // Info: (20260113 - Luphia) --- Laria Reconstruction ---
    const { originalFileSize, shards: shardCids, filename } = metadata;

    const totalShards = shardCids.length;
    const shardsPerStripe = TOTAL_SHARDS;
    const totalStripes = Math.ceil(totalShards / shardsPerStripe);
    let downloadedBytes = 0;
    const totalExpectedDownload = totalShards * SHARD_SIZE; // Approximate

    const reconstructedStripes: Uint8Array[] = [];

    for (let stripeIdx = 0; stripeIdx < totalStripes; stripeIdx++) {
      const stripeShardsCids = shardCids.slice(stripeIdx * shardsPerStripe, (stripeIdx + 1) * shardsPerStripe);

      const shards: (Uint8Array | null)[] = new Array(TOTAL_SHARDS).fill(null);

      // Info: (20260113 - Luphia) Parallel download of shards for this stripe
      await Promise.all(stripeShardsCids.map(async (shardCid, localIdx) => {
        try {
          const blob = await downloadSingleFile(shardCid);
          const buffer = await blob.arrayBuffer();
          shards[localIdx] = new Uint8Array(buffer);

          downloadedBytes += SHARD_SIZE;
          if (callbacks.onProgress) {
            callbacks.onProgress((downloadedBytes / totalExpectedDownload) * 90); // Up to 90%
          }
        } catch {
          // Info: (20260113 - Luphia) Missing shard
          shards[localIdx] = null;
        }
      }));

      // Info: (20260113 - Luphia) Reconstruct
      // Info: (20260113 - Luphia) Check sufficiency
      const validShardsCount = shards.filter(s => s !== null).length;
      if (validShardsCount < DATA_SHARDS) {
        throw new Error(`Insufficient shards to reconstruct stripe ${stripeIdx}. Needed ${DATA_SHARDS}, got ${validShardsCount}.`);
      }

      await rse.reconstruct(shards);

      // Info: (20260113 - Luphia) Collect data shards
      const dataShards = shards.slice(0, DATA_SHARDS) as Uint8Array[];

      // Info: (20260113 - Luphia) Concat data shards for this stripe
      // Info: (20260113 - Luphia) Calculate size: each shard is SHARD_SIZE
      const stripeSize = DATA_SHARDS * SHARD_SIZE;
      const stripeBuffer = new Uint8Array(stripeSize);

      for (let i = 0; i < DATA_SHARDS; i++) {
        stripeBuffer.set(dataShards[i], i * SHARD_SIZE);
      }

      reconstructedStripes.push(stripeBuffer);
    }

    // Info: (20260113 - Luphia) Merge all stripes
    const finalBuffer = new Uint8Array(reconstructedStripes.reduce((acc, curr) => acc + curr.length, 0));
    let offset = 0;
    for (const stripe of reconstructedStripes) {
      finalBuffer.set(stripe, offset);
      offset += stripe.length;
    }

    // Info: (20260113 - Luphia) Truncate to original size
    const truncated = finalBuffer.slice(0, originalFileSize);

    const finalBlob = new Blob([truncated as unknown as BlobPart], { type: metadata.mimeType || 'application/octet-stream' });

    if (callbacks.onProgress) callbacks.onProgress(100);
    if (callbacks.onSuccess) callbacks.onSuccess(finalBlob, filename);

  } catch (err) {
    if (callbacks.onError) {
      callbacks.onError(err instanceof Error ? err.message : 'Download failed');
    }
  }
};
