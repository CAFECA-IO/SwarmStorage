import { useCallback, useEffect, useRef, useState } from 'react';
import type { IChatMember, IChatMessage, TChatEvent } from '@/lib/chat_hub';
import { ApiCode } from '@/lib/status';

/**
 * Info: (20261105 - Luphia)
 * 房間即時聊天 (客戶端)
 * - join 取得 token → EventSource 接收事件 → POST 發送訊息
 * - 訊息只存在這個分頁的記憶體，重新整理或離開即消失
 * - 斷線時自動重連 (伺服器重啟後會重新加入並取得新暱稱)
 */

export type TChatStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unauthorized' | 'expired';

export type TChatEntry =
  | { kind: 'message'; id: string; message: IChatMessage }
  | { kind: 'system'; id: string; text: string; at: number };

export interface IRoomChat {
  status: TChatStatus;
  me: IChatMember | null;
  online: number;
  entries: TChatEntry[];
  sendError: string;
  send: (text: string) => Promise<boolean>;
}

interface IUseRoomChatOptions {
  roomId: string | null;
  password?: string | null;
  enabled: boolean;
}

// Info: (20261105 - Luphia) 畫面上最多保留的訊息數 (僅限本機記憶體)
const MAX_ENTRIES = 300;

export function useRoomChat({ roomId, password, enabled }: IUseRoomChatOptions): IRoomChat {
  const [status, setStatus] = useState<TChatStatus>('idle');
  const [me, setMe] = useState<IChatMember | null>(null);
  const [online, setOnline] = useState(0);
  const [entries, setEntries] = useState<TChatEntry[]>([]);
  const [sendError, setSendError] = useState('');

  const tokenRef = useRef<string | null>(null);
  const passwordRef = useRef(password);
  useEffect(() => {
    passwordRef.current = password;
  }, [password]);

  useEffect(() => {
    if (!enabled || !roomId) return;

    let cancelled = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let joinedOnce = false;
    let myId = '';

    const push = (entry: TChatEntry) => setEntries(prev => [...prev, entry].slice(-MAX_ENTRIES));
    const system = (text: string) => push({ kind: 'system', id: `sys-${Date.now()}-${Math.random()}`, text, at: Date.now() });

    const stop = (finalStatus: TChatStatus) => {
      cancelled = true;
      source?.close();
      tokenRef.current = null;
      setStatus(finalStatus);
    };

    const handleEvent = (event: TChatEvent) => {
      if (event.type === 'ready') {
        attempts = 0;
        myId = event.me.memberId;
        setMe(event.me);
        setOnline(event.online);
        setStatus('connected');
        if (!joinedOnce) {
          joinedOnce = true;
          system(`You joined as ${event.me.nickname}`);
        }
      } else if (event.type === 'message') {
        push({ kind: 'message', id: event.message.id, message: event.message });
      } else if (event.type === 'presence') {
        setOnline(event.online);
        if (event.member.memberId !== myId) {
          system(`${event.member.nickname} ${event.action === 'join' ? 'joined' : 'left'}`);
        }
      } else if (event.type === 'expired') {
        system('This room has expired.');
        stop('expired');
      } else if (event.type === 'error') {
        system(event.message);
      }
    };

    const retry = () => {
      if (cancelled) return;
      attempts++;
      setStatus('reconnecting');
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
      retryTimer = setTimeout(connect, delay);
    };

    async function connect() {
      if (cancelled) return;
      try {
        const headers: Record<string, string> = {};
        if (passwordRef.current) headers['x-room-password'] = passwordRef.current;
        const res = await fetch(`/api/v1/room/${roomId}/chat/join`, { method: 'POST', headers });
        const data = await res.json();
        if (cancelled) return;

        if (data.code === ApiCode.UNAUTHORIZED) return stop('unauthorized');
        if (data.code === ApiCode.NOT_FOUND) return stop('expired');
        if (data.code !== ApiCode.OK) return retry();

        const token: string = data.payload.token;
        tokenRef.current = token;
        const es = new EventSource(`/api/v1/room/${roomId}/chat/stream?token=${encodeURIComponent(token)}`);
        source = es;
        es.onmessage = e => {
          try {
            handleEvent(JSON.parse(e.data) as TChatEvent);
          } catch {
            // Info: (20261105 - Luphia) 忽略無法解析的事件
          }
        };
        es.onerror = () => {
          if (cancelled) return;
          if (es.readyState === EventSource.CLOSED) {
            // Info: (20261105 - Luphia) token 失效 (例如伺服器重啟)：重新加入
            es.close();
            tokenRef.current = null;
            retry();
          } else {
            setStatus('reconnecting');
          }
        };
      } catch {
        retry();
      }
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      tokenRef.current = null;
    };
  }, [enabled, roomId]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const token = tokenRef.current;
      if (!token || !roomId) return false;
      setSendError('');
      try {
        const res = await fetch(`/api/v1/room/${roomId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ text }),
        });
        const data = await res.json();
        if (data.code !== ApiCode.OK) {
          setSendError(data.message || 'Message not sent');
          return false;
        }
        return true;
      } catch {
        setSendError('Network error, message not sent');
        return false;
      }
    },
    [roomId]
  );

  return {
    status: enabled && roomId && status === 'idle' ? 'connecting' : status,
    me,
    online,
    entries,
    sendError,
    send,
  };
}
