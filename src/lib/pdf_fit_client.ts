import { useCallback, useEffect, useState } from 'react';
import { ApiCode } from '@/lib/status';
import type { IRoomChat } from '@/lib/use_room_chat';
import type { IPdfAnalysis, IPdfFitJob, TFitLevel } from '@/lib/pdf_fit_plan';

/**
 * Info: (20261120 - Luphia)
 * PDF 壓縮與分割 (瀏覽器端)：呼叫 /pdf-fit API，並以聊天連線接收工作進度
 */

export interface IFitSettings {
  limitMb: number;
  level: TFitLevel;
  snap: boolean;
  // Info: (20261120 - Luphia) 自訂切點 (各段最後一頁，0 起算)；null 表示自動切段
  ends: number[] | null;
}

export interface IFitSample {
  page: number;
  original: string;
  compressed: string;
  originalBytes: number;
  compressedBytes: number;
  originalSize: { width: number; height: number };
  compressedSize: { width: number; height: number };
  imagesOnPage: number;
}

async function call<T>(roomId: string, token: string | null, init: { query?: Record<string, string>; body?: unknown }): Promise<T> {
  if (!token) throw new Error('Not connected to the room yet, try again in a moment');
  const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : '';
  const res = await fetch(`/api/v1/room/${roomId}/pdf-fit${query}`, {
    method: init.body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!data || data.code !== ApiCode.OK) throw new Error(data?.message || `Request failed (HTTP ${res.status})`);
  return data.payload as T;
}

export const fetchAnalysis = (roomId: string, token: string | null, file: string) => call<IPdfAnalysis>(roomId, token, { query: { file } });

export const fetchSample = (roomId: string, token: string | null, file: string, page: number, level: TFitLevel) =>
  call<{ sample: IFitSample | null }>(roomId, token, { query: { file, page: String(page), level } }).then(r => r.sample);

export const startFit = (roomId: string, token: string | null, file: string, settings: IFitSettings) =>
  call<{ job: IPdfFitJob }>(roomId, token, { body: { action: 'start', file, ...settings, ends: settings.ends ?? undefined } }).then(r => r.job);

export const stopFit = (roomId: string, token: string | null, id: string) => call<{ job: IPdfFitJob }>(roomId, token, { body: { action: 'stop', id } });

/**
 * Info: (20261120 - Luphia)
 * 房間內的壓縮分割工作：連線後載入一次，之後由伺服器推送；dismissed 只影響自己的畫面
 */
export function usePdfFitJobs(roomId: string, chat: IRoomChat) {
  const [jobs, setJobs] = useState<IPdfFitJob[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const { getToken, subscribe, status } = chat;

  const upsert = useCallback((job: IPdfFitJob) => {
    setJobs(prev => [...prev.filter(j => j.id !== job.id), job].sort((a, b) => a.startedAt - b.startedAt));
  }, []);

  useEffect(
    () =>
      subscribe(event => {
        if (event.type === 'pdf-job') upsert(event.job);
      }),
    [subscribe, upsert]
  );

  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    call<{ jobs: IPdfFitJob[] }>(roomId, getToken(), {})
      .then(result => {
        if (!cancelled) setJobs(result.jobs.sort((a, b) => a.startedAt - b.startedAt));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getToken, roomId, status]);

  const dismiss = useCallback((id: string) => setDismissed(prev => new Set(prev).add(id)), []);
  return { jobs: jobs.filter(j => !dismissed.has(j.id)), upsert, dismiss };
}
