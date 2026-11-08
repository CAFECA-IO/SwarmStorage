import { useCallback, useEffect, useRef, useState } from 'react';
import type { IChatMember, IChatMessage, IUploadStatus, TChatEvent } from '@/lib/chat_hub';
import { ApiCode } from '@/lib/status';
import { memberHeaders } from '@/lib/member';

/**
 * Info: (20261105 - Luphia)
 * 房間即時聊天 (客戶端)
 * - join 取得 token → EventSource 接收事件 → POST 發送訊息
 * - 訊息只存在這個分頁的記憶體，重新整理或離開即消失
 * - 斷線時自動重連 (伺服器重啟後會重新加入並取得新暱稱)
 * Info: (20261105 - Luphia) 同一條連線也承載房間的即時上傳狀態與檔案新增事件
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
  // Info: (20261105 - Luphia) 房間中進行中的上傳 (含自己的)
  uploads: IUploadStatus[];
  reportUpload: (report: IUploadReportInput) => Promise<boolean>;
  getToken: () => string | null;
  // Info: (20261106 - Luphia) 通話人數 (由伺服器推送；尚未收到時為 null)
  callParticipants: number | null;
}

export interface IUploadReportInput {
  uploadId: string;
  filename: string;
  size: number;
  mimeType: string;
  shardsDone: number;
  shardsTotal: number;
  status: 'uploading' | 'failed' | 'cancelled' | 'complete';
  kind?: 'file' | 'folder';
  filesDone?: number;
  filesTotal?: number;
  parts?: { name: string; done: number; total: number }[];
}

interface IUseRoomChatOptions {
  roomId: string | null;
  password?: string | null;
  enabled: boolean;
  // Info: (20261105 - Luphia) 房間新增或更新檔案時呼叫 (uploadId 不為 null 表示是新上傳完成)
  onFile?: (metadata: Record<string, unknown>, uploadId: string | null) => void;
  // Info: (20261106 - Luphia) 檔案被刪除、房間設定變更
  onFileRemoved?: (filename: string) => void;
  onRoomSettings?: (settings: Record<string, unknown>) => void;
  // Info: (20261108 - Luphia) 資料夾上傳包完成
  onUploadComplete?: (upload: IUploadStatus) => void;
}

// Info: (20261105 - Luphia) 畫面上最多保留的訊息數 (僅限本機記憶體)
const MAX_ENTRIES = 300;

export function useRoomChat({ roomId, password, enabled, onFile, onFileRemoved, onRoomSettings, onUploadComplete }: IUseRoomChatOptions): IRoomChat {
  const [status, setStatus] = useState<TChatStatus>('idle');
  const [me, setMe] = useState<IChatMember | null>(null);
  const [online, setOnline] = useState(0);
  const [entries, setEntries] = useState<TChatEntry[]>([]);
  const [sendError, setSendError] = useState('');
  const [uploads, setUploads] = useState<Record<string, IUploadStatus>>({});
  const [callParticipants, setCallParticipants] = useState<number | null>(null);

  const onFileRef = useRef(onFile);
  const onFileRemovedRef = useRef(onFileRemoved);
  const onRoomSettingsRef = useRef(onRoomSettings);
  const onUploadCompleteRef = useRef(onUploadComplete);
  useEffect(() => {
    onFileRef.current = onFile;
    onFileRemovedRef.current = onFileRemoved;
    onRoomSettingsRef.current = onRoomSettings;
    onUploadCompleteRef.current = onUploadComplete;
  }, [onFile, onFileRemoved, onRoomSettings, onUploadComplete]);

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
    const knownUploads = new Map<string, IUploadStatus>();

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
        knownUploads.clear();
        event.uploads.forEach(u => knownUploads.set(u.uploadId, u));
        setUploads(Object.fromEntries(event.uploads.map(u => [u.uploadId, u])));
      } else if (event.type === 'upload') {
        const { upload } = event;
        const previous = knownUploads.get(upload.uploadId);
        const who = upload.uploader.memberId === myId ? 'You' : upload.uploader.nickname;
        if (!previous) {
          system(
            upload.kind === 'folder'
              ? `${who} started uploading the folder ${upload.filename} (${upload.filesTotal} files)`
              : `${who} started uploading ${upload.filename}`
          );
        }
        else if (previous.status === 'uploading' && upload.status === 'interrupted') system(`Upload of ${upload.filename} was interrupted`);
        knownUploads.set(upload.uploadId, upload);
        setUploads(prev => ({ ...prev, [upload.uploadId]: upload }));
      } else if (event.type === 'upload-removed') {
        const previous = knownUploads.get(event.uploadId);
        knownUploads.delete(event.uploadId);
        if (previous && event.reason === 'complete') {
          system(`${previous.filename} is ready (${previous.filesTotal ?? 0} files)`);
          onUploadCompleteRef.current?.(previous);
        } else if (previous && event.reason === 'cancelled') {
          const who = previous.uploader.memberId === myId ? 'You' : previous.uploader.nickname;
          system(`${who} cancelled the upload of ${previous.filename}`);
        } else if (previous) {
          system(`Upload of ${previous.filename} ${event.reason === 'failed' ? 'failed' : 'stopped'}`);
        }
        setUploads(prev => {
          const next = { ...prev };
          delete next[event.uploadId];
          return next;
        });
      } else if (event.type === 'file') {
        // Info: (20261108 - Luphia) 資料夾中的檔案：上傳包完成時才結束上傳狀態並通知
        if (event.uploadId && !event.bundleId) {
          knownUploads.delete(event.uploadId);
          const id = event.uploadId;
          setUploads(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          if (typeof event.metadata.filename === 'string') system(`${event.metadata.filename} is ready`);
        }
        onFileRef.current?.(event.metadata, event.uploadId);
      } else if (event.type === 'file-removed') {
        onFileRemovedRef.current?.(event.filename);
      } else if (event.type === 'room-settings') {
        onRoomSettingsRef.current?.(event.settings);
      } else if (event.type === 'call') {
        setCallParticipants(event.participants);
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
        const res = await fetch(`/api/v1/room/${roomId}/chat/join`, {
          method: 'POST',
          headers: memberHeaders({}, passwordRef.current),
        });
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

  const reportUpload = useCallback(
    async (report: IUploadReportInput): Promise<boolean> => {
      const token = tokenRef.current;
      if (!token || !roomId) return false;
      try {
        const res = await fetch(`/api/v1/room/${roomId}/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(report),
          keepalive: report.status !== 'uploading',
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    [roomId]
  );

  const getToken = useCallback(() => tokenRef.current, []);

  return {
    status: enabled && roomId && status === 'idle' ? 'connecting' : status,
    uploads: Object.values(uploads).sort((a, b) => a.startedAt - b.startedAt),
    reportUpload,
    getToken,
    callParticipants,
    me,
    online,
    entries,
    sendError,
    send,
  };
}
