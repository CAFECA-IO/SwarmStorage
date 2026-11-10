import { useEffect, useRef, useState } from 'react';
import type { IUploadStatus } from '@/lib/chat_hub';

/**
 * Info: (20261110 - Luphia)
 * 上傳是否「正在動」：由畫面端記錄進度的變化 (位元組、分片、檔案數)，計算即時速度與多久沒有新進度
 * 伺服器的 updatedAt 也會因心跳而更新，不能代表有進度，因此在這裡自行判斷
 */

const SPEED_WINDOW_MS = 8 * 1000;
// Info: (20261110 - Luphia) 超過這段時間沒有新進度就停止動態效果並顯示「多久沒有新資料」
export const IDLE_AFTER_MS = 10 * 1000;

export interface IUploadMotion {
  moving: boolean;
  // Info: (20261110 - Luphia) bytes / 秒；樣本不足時為 null
  speed: number | null;
  idleSeconds: number;
}

const progressBytes = (upload: IUploadStatus) =>
  typeof upload.bytesDone === 'number' ? upload.bytesDone : upload.shardsTotal ? (upload.size * upload.shardsDone) / upload.shardsTotal : 0;

export function useUploadMotion(upload: IUploadStatus, paused = false): IUploadMotion {
  const bytes = progressBytes(upload);
  const signature = `${bytes}|${upload.shardsDone}|${upload.filesDone ?? 0}`;
  const samples = useRef<{ t: number; bytes: number }[]>([]);
  const lastChange = useRef<number>(0);
  const [motion, setMotion] = useState<IUploadMotion>({ moving: true, speed: null, idleSeconds: 0 });
  const active = upload.status === 'uploading' && !paused;

  useEffect(() => {
    const now = Date.now();
    lastChange.current = now;
    samples.current = [...samples.current.filter(s => now - s.t <= SPEED_WINDOW_MS), { t: now, bytes }];
  }, [signature, bytes]);

  useEffect(() => {
    const update = () => {
      const now = Date.now();
      const since = lastChange.current ? now - lastChange.current : 0;
      const recent = samples.current.filter(s => now - s.t <= SPEED_WINDOW_MS);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const span = first ? (now - first.t) / 1000 : 0;
      // Info: (20261110 - Luphia) 最近 8 秒的平均速度；沒有新樣本時自然下降
      const speed = first && last && span >= 1 && last.bytes > first.bytes ? (last.bytes - first.bytes) / span : null;
      const next: IUploadMotion = { moving: active && since < IDLE_AFTER_MS, speed: active && since < IDLE_AFTER_MS ? speed : null, idleSeconds: Math.floor(since / 1000) };
      setMotion(prev => (prev.moving === next.moving && prev.speed === next.speed && prev.idleSeconds === next.idleSeconds ? prev : next));
    };
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active]);

  return active ? motion : { moving: false, speed: null, idleSeconds: motion.idleSeconds };
}

export const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(bytesPerSecond >= 10 * 1024 * 1024 ? 0 : 1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
};

export const formatIdle = (seconds: number): string => (seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`);
