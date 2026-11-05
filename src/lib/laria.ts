import { promises as fs, createReadStream, createWriteStream } from 'fs';
import type { FileHandle } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, type Hash } from 'crypto';
import path from 'path';
import { ReedSolomonErasure } from '@/lib/reed_solomon_erasure';

/**
 * Info: (20261105 - Luphia)
 * Laria 儲存引擎 (伺服器端)
 * 1. 以 AES-256-GCM 串流加密原始檔案 (密文長度 = 原始長度)
 * 2. 將密文切為 20 MB 條帶 (stripe)，最後一條以 0 填滿
 * 3. 每條帶拆成 5 個 4 MB 資料切片，以 Reed-Solomon (8, 5) 計算 3 個同位切片
 * 4. 第 i 個切片依序附加至 shard-i.bin，並計算 SHA-256 作為完整性校驗
 * 5. metadata.json 記錄演算法、IV、驗證標籤與切片雜湊；金鑰不寫入 metadata，由呼叫端保管
 */

// --- Info: (20251028 - Luphia) 演算法配置 (n=8, k=5) ---
const DATA_SHARDS: number = 5;
const PARITY_SHARDS: number = 3;
const TOTAL_SHARDS: number = DATA_SHARDS + PARITY_SHARDS;

// --- Info: (20251028 - Luphia) 固定參數 ---
const SHARD_SIZE: number = 4 * 1024 * 1024; // 固定 4MB
const DATA_STRIPE_SIZE: number = DATA_SHARDS * SHARD_SIZE; // 20MB

// --- Info: (20261105 - Luphia) 加密與格式參數 ---
const LARIA_VERSION = 1;
const CIPHER_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const METADATA_FILENAME = 'metadata.json';
const READ_CHUNK_SIZE = 1024 * 1024;

const rse = new ReedSolomonErasure(DATA_SHARDS, PARITY_SHARDS);

export interface ILariaShardInfo {
  index: number;
  type: 'data' | 'parity';
  file: string;
  size: number;
  sha256: string;
}

export interface ILariaShardSetMetadata {
  version: number;
  originalFileSize: number;
  stripeCount: number;
  algorithm: {
    name: 'reed-solomon';
    k: number;
    m: number;
    shardSize: number;
    stripeSize: number;
  };
  encryption: {
    cipher: typeof CIPHER_ALGORITHM;
    iv: string;
    authTag: string;
  };
  shards: ILariaShardInfo[];
}

export interface ILariaEncodeOptions {
  // Info: (20261105 - Luphia) 32 bytes 金鑰 (Uint8Array 或 64 字元 hex)，未提供時自動產生
  key?: Uint8Array | string;
}

export interface ILariaEncodeResult {
  metadata: ILariaShardSetMetadata;
  // Info: (20261105 - Luphia) 解密金鑰 (hex)，遺失即無法還原檔案
  key: string;
}

export interface ILariaRecoverResult {
  outputFilePath: string;
  originalFileSize: number;
  usedShards: number[];
  missingShards: { index: number; reason: string }[];
  reconstructed: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shardFileName(index: number): string {
  return `shard-${index + 1}.bin`;
}

function normalizeKey(key: Uint8Array | string): Buffer {
  const buffer =
    typeof key === 'string'
      ? Buffer.from(key, isHex(key, KEY_LENGTH * 2) ? 'hex' : 'base64')
      : Buffer.from(key);
  if (buffer.length !== KEY_LENGTH) {
    throw new Error(`金鑰長度必須為 ${KEY_LENGTH} bytes`);
  }
  return buffer;
}

/**
 * Info: (20261105 - Luphia)
 * FileHandle.write / read 不保證一次處理完整緩衝區，需迴圈直到完成
 */
async function writeFully(handle: FileHandle, buffer: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    offset += bytesWritten;
  }
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error('切片檔案長度不足');
    offset += bytesRead;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath, { highWaterMark: READ_CHUNK_SIZE }), hash);
  return hash.digest('hex');
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/i.test(value);
}

/**
 * Info: (20261105 - Luphia)
 * 驗證 metadata 格式，並確認演算法參數與本引擎相容
 */
function parseMetadata(raw: unknown): ILariaShardSetMetadata {
  const meta = raw as ILariaShardSetMetadata;
  if (!meta || typeof meta !== 'object') throw new Error('metadata 格式錯誤');
  if (meta.version !== LARIA_VERSION) throw new Error(`不支援的 metadata 版本: ${meta.version}`);
  if (!Number.isInteger(meta.originalFileSize) || meta.originalFileSize < 0) {
    throw new Error('metadata 缺少 originalFileSize');
  }
  if (!Number.isInteger(meta.stripeCount) || meta.stripeCount !== Math.ceil(meta.originalFileSize / DATA_STRIPE_SIZE)) {
    throw new Error('metadata stripeCount 與檔案大小不符');
  }
  const { algorithm, encryption, shards } = meta;
  if (
    algorithm?.name !== 'reed-solomon' ||
    algorithm.k !== DATA_SHARDS ||
    algorithm.m !== PARITY_SHARDS ||
    algorithm.shardSize !== SHARD_SIZE
  ) {
    throw new Error('metadata 演算法參數與 Laria (8, 5) / 4MB 不相容');
  }
  if (
    encryption?.cipher !== CIPHER_ALGORITHM ||
    !isHex(encryption.iv, IV_LENGTH * 2) ||
    !isHex(encryption.authTag, AUTH_TAG_LENGTH * 2)
  ) {
    throw new Error('metadata 加密參數錯誤');
  }
  if (!Array.isArray(shards) || shards.length !== TOTAL_SHARDS) {
    throw new Error(`metadata 必須包含 ${TOTAL_SHARDS} 個切片資訊`);
  }
  shards.forEach((shard, i) => {
    if (shard?.index !== i || shard.file !== shardFileName(i) || !isHex(shard.sha256, 64)) {
      throw new Error(`metadata 切片 ${i + 1} 資訊錯誤`);
    }
  });
  return meta;
}

/**
 * Info: (20261105 - Luphia)
 * 檢查單一切片是否可用：存在、大小正確、SHA-256 相符
 * 損毀的切片視同遺失，交由 Reed-Solomon 補回
 */
async function inspectShard(shardsDir: string, shard: ILariaShardInfo): Promise<string | null> {
  const shardPath = path.join(shardsDir, shard.file);
  try {
    const stats = await fs.stat(shardPath);
    if (!stats.isFile()) return '不是檔案';
    if (stats.size !== shard.size) return `大小不符 (預期 ${shard.size}，實際 ${stats.size})`;
    const digest = await hashFile(shardPath);
    if (digest !== shard.sha256.toLowerCase()) return 'SHA-256 校驗失敗';
    return null;
  } catch (err: unknown) {
    return `無法讀取: ${errorMessage(err)}`;
  }
}

/**
 * Info: (20251028 - Luphia)
 * 編碼：將任意大小的檔案加密並切割為 8 個切片檔案 (串流處理)
 * @param filePath - 來源檔案路徑
 * @param outputDir - 切片存放目錄
 * @param options - 可指定加密金鑰
 * @returns metadata 與解密金鑰
 */
export async function encodeFile(
  filePath: string,
  outputDir: string,
  options: ILariaEncodeOptions = {}
): Promise<ILariaEncodeResult> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error(`不是檔案: ${filePath}`);

  const key = options.key ? normalizeKey(options.key) : randomBytes(KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  await fs.mkdir(outputDir, { recursive: true });

  // Info: (20261105 - Luphia) 重複使用同一組緩衝區：資料切片為條帶的 subarray，同位切片獨立配置
  const stripe = Buffer.alloc(DATA_STRIPE_SIZE);
  const shards: Buffer[] = [
    ...Array.from({ length: DATA_SHARDS }, (_, i) => stripe.subarray(i * SHARD_SIZE, (i + 1) * SHARD_SIZE)),
    ...Array.from({ length: PARITY_SHARDS }, () => Buffer.alloc(SHARD_SIZE)),
  ];
  const hashes: Hash[] = Array.from({ length: TOTAL_SHARDS }, () => createHash('sha256'));
  const writerHandles: FileHandle[] = [];

  let filled = 0;
  let stripeCount = 0;

  const flushStripe = async (): Promise<void> => {
    // Info: (20251028 - Luphia) 處理最後一塊 (Padding)
    if (filled < DATA_STRIPE_SIZE) stripe.fill(0, filled);
    rse.encode(shards);
    await Promise.all(
      shards.map((shard, i) => {
        hashes[i].update(shard);
        return writeFully(writerHandles[i], shard);
      })
    );
    stripeCount++;
    filled = 0;
  };

  try {
    for (let i = 0; i < TOTAL_SHARDS; i++) {
      writerHandles.push(await fs.open(path.join(outputDir, shardFileName(i)), 'w'));
    }

    await pipeline(
      createReadStream(filePath, { highWaterMark: READ_CHUNK_SIZE }),
      cipher,
      async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) {
          let offset = 0;
          while (offset < chunk.length) {
            const length = Math.min(chunk.length - offset, DATA_STRIPE_SIZE - filled);
            chunk.copy(stripe, filled, offset, offset + length);
            filled += length;
            offset += length;
            if (filled === DATA_STRIPE_SIZE) await flushStripe();
          }
        }
        if (filled > 0) await flushStripe();
      }
    );
  } finally {
    await Promise.all(writerHandles.map(handle => handle.close()));
  }

  const metadata: ILariaShardSetMetadata = {
    version: LARIA_VERSION,
    originalFileSize: stats.size,
    stripeCount,
    algorithm: {
      name: 'reed-solomon',
      k: DATA_SHARDS,
      m: PARITY_SHARDS,
      shardSize: SHARD_SIZE,
      stripeSize: DATA_STRIPE_SIZE,
    },
    encryption: {
      cipher: CIPHER_ALGORITHM,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
    },
    shards: hashes.map((hash, i) => ({
      index: i,
      type: i < DATA_SHARDS ? 'data' : 'parity',
      file: shardFileName(i),
      size: stripeCount * SHARD_SIZE,
      sha256: hash.digest('hex'),
    })),
  };

  await fs.writeFile(path.join(outputDir, METADATA_FILENAME), JSON.stringify(metadata, null, 2));

  return { metadata, key: key.toString('hex') };
}

/**
 * Info: (20251028 - Luphia)
 * 恢復：從可用的切片中恢復原始檔案 (串流處理)
 * - 任意 5 個完好切片即可還原；遺失或校驗失敗的切片會被略過
 * - 先寫入暫存檔，GCM 驗證標籤通過後才改名為輸出檔，避免留下未驗證的明文
 * @param shardsDir - 切片存放目錄
 * @param outputFilePath - 恢復後的檔案存放路徑
 * @param key - encodeFile 回傳的解密金鑰
 */
export async function recoverFile(
  shardsDir: string,
  outputFilePath: string,
  key: Uint8Array | string
): Promise<ILariaRecoverResult> {
  const decryptKey = normalizeKey(key);

  let metadata: ILariaShardSetMetadata;
  try {
    const raw = await fs.readFile(path.join(shardsDir, METADATA_FILENAME), 'utf8');
    metadata = parseMetadata(JSON.parse(raw));
  } catch (err: unknown) {
    throw new Error(`讀取 metadata 失敗，檔案無法恢復: ${errorMessage(err)}`);
  }

  // Info: (20261105 - Luphia) 平行檢查 8 個切片
  const problems = await Promise.all(metadata.shards.map(shard => inspectShard(shardsDir, shard)));
  const available: number[] = [];
  const missingShards: { index: number; reason: string }[] = [];
  problems.forEach((reason, i) => {
    if (reason === null) available.push(i);
    else missingShards.push({ index: i, reason });
  });

  if (available.length < DATA_SHARDS) {
    throw new Error(
      `恢復失敗：需要 ${DATA_SHARDS} 個完好切片，只有 ${available.length} 個 (` +
        missingShards.map(s => `切片 ${s.index + 1}: ${s.reason}`).join('; ') +
        ')'
    );
  }

  // Info: (20261105 - Luphia) 只讀取 k 個切片；索引較小者優先，資料切片齊全時不需解碼
  const usedShards = available.slice(0, DATA_SHARDS);
  const reconstructed = usedShards.some(i => i >= DATA_SHARDS);

  const decipher = createDecipheriv(CIPHER_ALGORITHM, decryptKey, Buffer.from(metadata.encryption.iv, 'hex'), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(metadata.encryption.authTag, 'hex'));

  const tempPath = `${outputFilePath}.${randomBytes(6).toString('hex')}.partial`;
  const readerHandles = new Map<number, FileHandle>();

  try {
    for (const index of usedShards) {
      readerHandles.set(index, await fs.open(path.join(shardsDir, metadata.shards[index].file), 'r'));
    }

    const { stripeCount, originalFileSize } = metadata;

    await pipeline(
      async function* () {
        let remaining = originalFileSize;
        for (let s = 0; s < stripeCount; s++) {
          const shards: (Buffer | null)[] = new Array(TOTAL_SHARDS).fill(null);
          await Promise.all(
            usedShards.map(async index => {
              const buffer = Buffer.alloc(SHARD_SIZE);
              await readFully(readerHandles.get(index) as FileHandle, buffer, s * SHARD_SIZE);
              shards[index] = buffer;
            })
          );

          // Info: (20261105 - Luphia) 執行 Reed-Solomon 恢復，只補回資料切片
          const dataShards = rse.reconstruct(shards, true).slice(0, DATA_SHARDS);

          // Info: (20261105 - Luphia) 依序輸出資料切片，並去除最後一條帶的填充
          for (const shard of dataShards) {
            if (remaining <= 0) break;
            const length = Math.min(remaining, SHARD_SIZE);
            yield length === SHARD_SIZE ? shard : shard.subarray(0, length);
            remaining -= length;
          }
        }
      },
      decipher,
      createWriteStream(tempPath)
    );

    await fs.rename(tempPath, outputFilePath);
  } catch (err: unknown) {
    await fs.rm(tempPath, { force: true });
    const message = errorMessage(err);
    if (/unable to authenticate/i.test(message)) {
      throw new Error('解密驗證失敗：金鑰錯誤或資料遭竄改');
    }
    throw new Error(`恢復失敗: ${message}`);
  } finally {
    await Promise.all([...readerHandles.values()].map(handle => handle.close()));
  }

  return {
    outputFilePath,
    originalFileSize: metadata.originalFileSize,
    usedShards,
    missingShards,
    reconstructed,
  };
}
