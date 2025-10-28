import { promises as fs, createReadStream, type ReadStream, Stats } from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
// ToDo: (20251028 - Luphia) 尋找或建立更好的 Reed-Solomon Erasure Code 實作庫
// import { ReedSolomonErasure } from '@/lib/reed_solomon_erasure';
class ReedSolomonErasure {
  private dataShards: number;
  private parityShards: number;

  constructor(dataShards: number, parityShards: number) {
    this.dataShards = dataShards;
    this.parityShards = parityShards;
  }

  async encode(shards: Buffer[]): Promise<void> {
    // Info: (20251028 - Luphia) 模擬編碼過程 (實際應用中應使用真實的 Reed-Solomon 編碼)
    for (let i = this.dataShards; i < this.dataShards + this.parityShards; i++) {
      shards[i] = Buffer.alloc(shards[0].length, 0); // 簡單填充為零
    }
  }

  async reconstruct(shards: (Buffer | null)[]): Promise<void> {
    // Info: (20251028 - Luphia) 模擬恢復過程 (實際應用中應使用真實的 Reed-Solomon 恢復)
    for (let i = 0; i < shards.length; i++) {
      if (shards[i] === null) {
        // Info: (20251028 - Luphia) 簡單填充為零
        shards[i] = Buffer.alloc(shards[0]!.length, 0);
      }
    }
  }
}

// --- Info: (20251028 - Luphia) 演算法配置 (n=8, k=5) ---
const DATA_SHARDS: number = 5;
const PARITY_SHARDS: number = 3;
const TOTAL_SHARDS: number = DATA_SHARDS + PARITY_SHARDS;

// --- Info: (20251028 - Luphia) 新的固定參數 ---
const SHARD_SIZE: number = 4 * 1024 * 1024; // 固定 4MB
const DATA_STRIPE_SIZE: number = DATA_SHARDS * SHARD_SIZE; // 20MB

// Info: (20251028 - Luphia) 實例化 Reed-Solomon 編碼器
const rse = new ReedSolomonErasure(DATA_SHARDS, PARITY_SHARDS);

/**
 * Info: (20251028 - Luphia)
 * 檢查檔案是否存在
 */
async function validateFileExists(filePath: string): Promise<Stats | null> {
  try {
    const stats: Stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size === 0) {
      console.error('[錯誤] 檔案不存在或是空的。');
      return null;
    }
    return stats;
  } catch (err: unknown) {
    console.error(`[錯誤] 無法存取檔案: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Info: (20251028 - Luphia)
 * 編碼：將任意大小的檔案切割為 8 個固定切片大小的檔案 (串流處理)
 * @param filePath - 來源檔案路徑
 * @param outputDir - 切片存放目錄
 */
export async function encodeFile(filePath: string, outputDir: string): Promise<void> {
  console.log(`[編碼] (8, 5) 開始處理檔案: ${filePath}`);

  const stats: Stats | null = await validateFileExists(filePath);
  if (!stats) return;

  const originalFileSize: number = stats.size;
  console.log(`[編碼] 原始檔案大小: ${originalFileSize} bytes`);

  try {
    // Info: (20251028 - Luphia) 建立輸出目錄並儲存 metadata
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      path.join(outputDir, 'metadata.json'),
      JSON.stringify({ originalFileSize })
    );

    // Info: (20251028 - Luphia) 建立 8 個檔案寫入句柄
    const writerHandles: FileHandle[] = await Promise.all(
      Array.from({ length: TOTAL_SHARDS }, (_, i) => {
        const shardPath = path.join(outputDir, `shard-${i + 1}.bin`);
        return fs.open(shardPath, 'w');
      })
    );

    // Info: (20251028 - Luphia) 建立檔案讀取串流 (20MB)
    const readStream: ReadStream = createReadStream(filePath, { highWaterMark: DATA_STRIPE_SIZE });

    // Info: (20251028 - Luphia) 逐塊處理檔案
    for await (const chunk of readStream) {
      let dataStripe: Buffer = chunk as Buffer; // Info: (20251028 - Luphia) chunk 預設為 Buffer

      // Info: (20251028 - Luphia) 處理最後一塊 (Padding)
      if (dataStripe.length < DATA_STRIPE_SIZE) {
        const paddedStripe = Buffer.alloc(DATA_STRIPE_SIZE);
        dataStripe.copy(paddedStripe, 0);
        dataStripe = paddedStripe;
        console.log(`[編碼] 偵測到檔案結尾，填充 ${DATA_STRIPE_SIZE - chunk.length} bytes。`);
      }

      // Info: (20251028 - Luphia) 準備 shards 陣列 (k=5 個資料 + m=3 個空緩衝區)
      const shards: Buffer[] = [];
      for (let i = 0; i < DATA_SHARDS; i++) {
        shards.push(dataStripe.subarray(i * SHARD_SIZE, (i + 1) * SHARD_SIZE));
      }
      for (let i = 0; i < PARITY_SHARDS; i++) {
        shards.push(Buffer.alloc(SHARD_SIZE));
      }

      // Info: (20251028 - Luphia) 執行 Reed-Solomon 編碼 (5+3)
      await rse.encode(shards);

      // Info: (20251028 - Luphia) 將 8 個 4MB 切片寫入各自的檔案
      await Promise.all(
        shards.map((shard, i) => writerHandles[i].write(shard, 0, shard.length))
      );
    }

    // Info: (20251028 - Luphia) 關閉所有檔案
    await Promise.all(writerHandles.map(handle => handle.close()));
    console.log(`[編碼] ${TOTAL_SHARDS} 個切片已成功寫入 ${outputDir}`);

  } catch (err: unknown) {
    console.error(`[編碼] 處理失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Info: (20251028 - Luphia)
 * 恢復：從可用的切片中恢復原始檔案 (串流處理)
 * @param shardsDir - 切片存放目錄
 * @param outputFilePath - 恢復後的檔案存放路徑
 */
export async function recoverFile(shardsDir: string, outputFilePath: string): Promise<void> {
  console.log(`[恢復] (8, 5) 開始從 ${shardsDir} 嘗試恢復檔案...`);

  let originalFileSize: number;
  try {
    // Info: (20251028 - Luphia) 讀取元資料
    const metaPath = path.join(shardsDir, 'metadata.json');
    const metaBuffer: Buffer = await fs.readFile(metaPath);

    // Info: (20251028 - Luphia) 型別安全的解析
    const metaData: { originalFileSize?: number } = JSON.parse(metaBuffer.toString());
    if (typeof metaData.originalFileSize !== 'number') {
      throw new Error('metadata 格式錯誤，缺少 originalFileSize');
    }
    originalFileSize = metaData.originalFileSize;
    console.log(`[恢復] 目標檔案大小: ${originalFileSize} bytes`);

  } catch (err: unknown) {
    console.error(`[錯誤] 讀取 metadata 失敗，檔案無法恢復: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const readerHandles: (FileHandle | null)[] = new Array(TOTAL_SHARDS).fill(null);
  let foundShards: number = 0;
  let outputHandle: FileHandle | undefined;

  try {
    // Info: (20251028 - Luphia) 嘗試開啟所有 8 個切片的檔案存取器
    for (let i = 0; i < TOTAL_SHARDS; i++) {
      const shardPath = path.join(shardsDir, `shard-${i + 1}.bin`);
      try {
        readerHandles[i] = await fs.open(shardPath, 'r');
        foundShards++;
      } catch (err: unknown) {
        console.warn(`[恢復] 偵測到切片 ${i + 1} 遺失: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`[恢復] 總共找到 ${foundShards} / ${TOTAL_SHARDS} 個切片。`);

    // Info: (20251028 - Luphia) 檢查是否滿足恢復條件 (k=5)
    if (foundShards < DATA_SHARDS) {
      throw new Error(`恢復失敗。需要 ${DATA_SHARDS} (5) 個切片，但只找到 ${foundShards} 個。`);
    }

    // Info: (20251028 - Luphia) 開啟輸出檔案存取器
    outputHandle = await fs.open(outputFilePath, 'w');

    // Info: (20251028 - Luphia) 逐個 "Stripe" 讀取、恢復、寫入
    while (true) {
      const shards: (Buffer | null)[] = new Array(TOTAL_SHARDS).fill(null);
      const readBuffers: (Buffer | null)[] = new Array(TOTAL_SHARDS).fill(null);
      let shardsAvailableThisStripe: number = 0;
      let totalBytesReadThisStripe: number = 0;

      // Info: (20251028 - Luphia) 嘗試從所有存在的檔案存取器中讀取 4MB
      const readPromises = readerHandles.map((handle, i) => {
        if (handle) {
          const buffer = Buffer.alloc(SHARD_SIZE);
          readBuffers[i] = buffer;
          return handle.read(buffer, 0, SHARD_SIZE, null);
        }
        return Promise.resolve(null);
      });

      const results = await Promise.all(readPromises);

      // Info: (20251028 - Luphia) 檢查讀取結果
      for (let i = 0; i < TOTAL_SHARDS; i++) {
        const result = results[i]; // Info: (20251028 - Luphia) 型別為 FileHandle.ReadResult | null
        if (result && result.bytesRead > 0) {
          if (result.bytesRead !== SHARD_SIZE) {
            throw new Error(`切片 ${i + 1} 損毀: 讀取到不完整的 4MB 區塊。`);
          }
          shards[i] = readBuffers[i];
          shardsAvailableThisStripe++;
          totalBytesReadThisStripe += result.bytesRead;
        }
      }

      if (totalBytesReadThisStripe === 0) {
        console.log('[恢復] 已到達所有切片檔案結尾。');
        break; // Info: (20251028 - Luphia) 完成檔案，結束迴圈
      }

      if (shardsAvailableThisStripe < DATA_SHARDS) {
        throw new Error(`恢復中途失敗。可用的切片不足 ${DATA_SHARDS} (5) 個。`);
      }

      // Info: (20251028 - Luphia) 填充遺失的切片 (用空 Buffer 佔位)
      for (let i = 0; i < TOTAL_SHARDS; i++) {
        if (shards[i] === null) {
          shards[i] = Buffer.alloc(SHARD_SIZE);
        }
      }

      // Info: (20251028 - Luphia) 執行 Reed-Solomon 恢復 (5+3)
      await rse.reconstruct(shards);

      /**
       * Info: (20251028 - Luphia)
       * 組合原始資料 (前 k=5 個資料切片)
       */
      const dataShards: Buffer[] = shards.slice(0, DATA_SHARDS) as Buffer[];
      const dataStripe: Buffer = Buffer.concat(dataShards);
      await outputHandle.write(dataStripe);
    }

    // Info: (20251028 - Luphia) 裁剪檔案至原始大小
    await outputHandle.truncate(originalFileSize);
    console.log(`[恢復] 檔案已成功恢復。 總大小: ${originalFileSize} bytes`);

  } catch (err: unknown) {
    console.error(`[恢復] 處理失敗: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Info: (20251028 - Luphia) 關閉所有檔案句柄
    if (outputHandle) await outputHandle.close();
    await Promise.all(readerHandles.map(handle => handle && handle.close()));
  }
}
