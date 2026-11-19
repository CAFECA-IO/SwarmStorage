import { useCallback, useEffect, useRef, useState } from 'react';
import type { TChatEvent } from '@/lib/chat_hub';
import type { IDocBlockState, IDocComment, IDocHistoryEntry, IDocPerson, IDocSection, TDocAccess, TDocOp } from '@/lib/doc_hub';
import type { IRoomChat } from '@/lib/use_room_chat';
import { ApiCode } from '@/lib/status';

/**
 * Info: (20261118 - Luphia)
 * 文件共筆 (客戶端)：載入伺服器上的文件狀態，依房間即時通道套用其他人的修改、編輯鎖與分工資訊
 * - 修改依序號 (rev) 套用；漏收時重新載入
 * - 每 20 秒回報「在這份文件中」，離開時通知
 */

export interface IDocMember {
  memberId: string;
  id: string;
  name: string;
}

export interface IDocState {
  rev: number;
  savedRev: number;
  savedAt: number;
  front: string | null;
  blocks: IDocBlockState[];
  locks: Record<string, { memberId: string; name: string }>;
  viewers: IDocMember[];
  access: TDocAccess;
  sections: Record<string, IDocSection>;
  comments: IDocComment[];
  history: IDocHistoryEntry[];
  historyTotal: number;
  people: Record<string, string>;
  creatorId: string | null;
  me: { memberId: string; id: string; name: string; canWrite: boolean; manager: boolean };
  members: IDocMember[];
}

export type TActResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };

const HEARTBEAT_MS = 20 * 1000;

export function applyDocOp(doc: IDocState, op: TDocOp): IDocState | null {
  if (op.type === 'front') return { ...doc, front: op.front };
  if (op.type === 'reset') return { ...doc, front: op.front, blocks: op.blocks };
  const blocks = [...doc.blocks];
  if (op.type === 'replace') {
    const index = blocks.findIndex(b => b.id === op.id);
    if (index < 0) return null;
    blocks.splice(index, 1, ...op.blocks);
  } else {
    const index = op.afterId ? blocks.findIndex(b => b.id === op.afterId) : -1;
    if (op.afterId && index < 0) return null;
    blocks.splice(index + 1, 0, ...op.blocks);
  }
  return { ...doc, blocks };
}

export function useDocSession({ roomId, filename, chat, createSource }: { roomId: string; filename: string; chat: IRoomChat; createSource: string | null }) {
  const [doc, setDoc] = useState<IDocState | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const docRef = useRef<IDocState | null>(null);
  const created = useRef(false);
  const memberId = chat.me?.memberId ?? null;
  const { getToken, subscribe } = chat;


  const post = useCallback(
    async (body: Record<string, unknown>): Promise<TActResult> => {
      const token = getToken();
      if (!token) return { ok: false, code: 'OFFLINE', message: 'Reconnecting to the room…' };
      try {
        const res = await fetch(`/api/v1/room/${roomId}/docs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ file: filename, ...body }),
          keepalive: body.action === 'leave',
        });
        const data = await res.json().catch(() => null);
        if (data?.code === ApiCode.OK) return { ok: true, data: (data.payload as Record<string, unknown>) ?? {} };
        return { ok: false, code: data?.code ?? 'ERROR', message: data?.message || `Request failed (HTTP ${res.status})` };
      } catch {
        return { ok: false, code: 'OFFLINE', message: 'Network error' };
      }
    },
    [filename, getToken, roomId]
  );

  const load = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    if (createSource !== null && !created.current) {
      created.current = true;
      const result = await post({ action: 'create', source: createSource });
      if (!result.ok && result.code !== ApiCode.CONFLICT) {
        setStatus('error');
        setError(result.message);
        return;
      }
    }
    try {
      const res = await fetch(`/api/v1/room/${roomId}/docs?file=${encodeURIComponent(filename)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => null);
      if (data?.code === ApiCode.OK) {
        docRef.current = data.payload as IDocState;
        setDoc(docRef.current);
        setStatus('ready');
        setError(null);
      } else if (data?.code === ApiCode.NOT_FOUND) {
        setStatus('missing');
      } else {
        setStatus('error');
        setError(data?.message || 'The document could not be opened');
      }
    } catch {
      setStatus('error');
      setError('Network error');
    }
  }, [createSource, filename, getToken, post, roomId]);

  // Info: (20261118 - Luphia) 連上房間 (或重新連線換了身分) 後載入
  useEffect(() => {
    if (!memberId) return;
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [memberId, load]);

  useEffect(
    () =>
      subscribe((event: TChatEvent) => {
        if (event.type !== 'doc' || event.filename !== filename) return;
        const payload = event.payload;
        const current = docRef.current;
        // Info: (20261118 - Luphia) 同一輪可能收到多個事件：以 ref 同步累積，避免後面的事件蓋掉前面的
        const update = (fn: (prev: IDocState) => IDocState) => {
          if (!docRef.current) return;
          docRef.current = fn(docRef.current);
          setDoc(docRef.current);
        };
        switch (payload.kind) {
          case 'op': {
            if (!current) return;
            const rev = Number(payload.rev);
            if (rev <= current.rev) return;
            const next = rev === current.rev + 1 ? applyDocOp(current, payload.op as TDocOp) : null;
            if (!next) {
              load();
              return;
            }
            docRef.current = { ...next, rev };
            setDoc(docRef.current);
            return;
          }
          case 'presence':
            update(prev => ({ ...prev, locks: payload.locks as IDocState['locks'], viewers: payload.viewers as IDocMember[] }));
            return;
          case 'meta':
            update(prev => ({
              ...prev,
              access: payload.access as TDocAccess,
              sections: payload.sections as Record<string, IDocSection>,
              comments: payload.comments as IDocComment[],
              history: payload.history as IDocHistoryEntry[],
              historyTotal: Number(payload.historyTotal) || 0,
              people: payload.people as Record<string, string>,
            }));
            return;
          case 'saved':
            setSaveError(null);
            update(prev => ({ ...prev, savedRev: Math.max(prev.savedRev, Number(payload.rev)), savedAt: Number(payload.at) }));
            return;
          case 'save-error':
            setSaveError(String(payload.message || 'Saving failed'));
            return;
          case 'reload':
            load();
            return;
        }
      }),
    [filename, load, subscribe]
  );

  // Info: (20261118 - Luphia) 在文件中的心跳；離開時通知 (釋放編輯鎖)
  useEffect(() => {
    if (status !== 'ready') return;
    const timer = setInterval(() => post({ action: 'here' }), HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [post, status]);
  useEffect(() => () => void post({ action: 'leave' }), [post]);

  // Info: (20261118 - Luphia) 線上成員 (指派負責人用) 隨聊天室在線狀態更新
  const refreshMembers = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    const res = await fetch(`/api/v1/room/${roomId}/docs?file=${encodeURIComponent(filename)}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (data?.code === ApiCode.OK && docRef.current) {
      docRef.current = { ...docRef.current, members: (data.payload as IDocState).members };
      setDoc(docRef.current);
    }
  }, [filename, getToken, roomId]);

  return { doc, status, error, saveError, act: post, reload: load, refreshMembers };
}

export type { IDocPerson };
