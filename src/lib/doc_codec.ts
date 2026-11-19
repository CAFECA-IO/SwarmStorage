import { ReedSolomonErasure } from '@/lib/reed_solomon_erasure';

/**
 * Info: (20261118 - Luphia)
 * 房間檔案的分片格式 (瀏覽器上傳與伺服器端文件存檔共用)：
 * 每 5 個資料分片加 3 個 Reed-Solomon 同位分片為一條帶，最後一條帶補 0；
 * 小於一條帶 (20MB) 的檔案分片大小為「檔案大小 / 5」(1KB 對齊)
 */

export const DATA_SHARDS = 5;
export const PARITY_SHARDS = 3;
export const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;
export const SHARD_SIZE = 4 * 1024 * 1024;
export const DATA_STRIPE_SIZE = DATA_SHARDS * SHARD_SIZE;
const SHARD_ALIGN = 1024;

export const shardSizeFor = (size: number): number =>
  size >= DATA_STRIPE_SIZE ? SHARD_SIZE : Math.max(SHARD_ALIGN, Math.ceil(size / DATA_SHARDS / SHARD_ALIGN) * SHARD_ALIGN);

const rse = new ReedSolomonErasure(DATA_SHARDS, PARITY_SHARDS);

export function encodeShards(bytes: Uint8Array): { shardSize: number; shards: Uint8Array[] } {
  const shardSize = shardSizeFor(bytes.length);
  const stripeSize = shardSize * DATA_SHARDS;
  const stripes = Math.ceil(bytes.length / stripeSize);
  const shards: Uint8Array[] = [];
  for (let s = 0; s < stripes; s++) {
    const stripe = new Uint8Array(stripeSize);
    stripe.set(bytes.subarray(s * stripeSize, Math.min((s + 1) * stripeSize, bytes.length)));
    const set: Uint8Array[] = [
      ...Array.from({ length: DATA_SHARDS }, (_, i) => stripe.slice(i * shardSize, (i + 1) * shardSize)),
      ...Array.from({ length: PARITY_SHARDS }, () => new Uint8Array(shardSize)),
    ];
    rse.encode(set);
    shards.push(...set);
  }
  return { shardSize, shards };
}

// Info: (20261118 - Luphia) 依序給 8 個一組的分片 (遺失為 null)，還原原始內容；每條帶至少要 5 個
export function decodeShards(pieces: (Uint8Array | null)[], size: number, shardSize: number): Uint8Array {
  const stripes = Math.ceil(pieces.length / TOTAL_SHARDS);
  const out = new Uint8Array(stripes * shardSize * DATA_SHARDS);
  for (let s = 0; s < stripes; s++) {
    const set = pieces.slice(s * TOTAL_SHARDS, (s + 1) * TOTAL_SHARDS).map(p => (p && p.length === shardSize ? p : null));
    if (set.slice(0, DATA_SHARDS).some(p => !p)) rse.reconstruct(set, true);
    for (let i = 0; i < DATA_SHARDS; i++) out.set(set[i] as Uint8Array, (s * DATA_SHARDS + i) * shardSize);
  }
  return out.subarray(0, size);
}
