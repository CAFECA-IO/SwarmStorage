import { useCallback, useEffect, useRef, useState } from 'react';
import { DisconnectReason, Room, RoomEvent, VideoPresets, type RoomOptions } from 'livekit-client';
import { ApiCode } from '@/lib/status';

export type TCallState = 'idle' | 'joining' | 'connected' | 'reconnecting';

export interface ICallInfo {
  enabled: boolean;
  participants: number;
  maxParticipants: number;
}

interface IUseRoomCallOptions {
  roomId: string;
  // Info: (20261106 - Luphia) 房間聊天 token (通過房間存取檢查後才有)
  getChatToken: () => string | null;
  chatReady: boolean;
  // Info: (20261106 - Luphia) 伺服器推送的通話人數 (LiveKit webhook)
  pushedParticipants: number | null;
}

// Info: (20261106 - Luphia) 未收到推送時，每 30 秒更新一次通話人數
const STATUS_POLL_MS = 30000;

/**
 * Info: (20261106 - Luphia)
 * 50 人會議的連線設定：
 * - simulcast：上傳 180p / 360p / 720p 三層，伺服器依每個人的格子大小轉發適合的一層
 * - adaptiveStream：只訂閱畫面上看得到的影像，並依元素大小選擇解析度
 * - dynacast：沒有人觀看的畫質層暫停編碼，節省上傳頻寬與 CPU
 */
const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
  publishDefaults: {
    simulcast: true,
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    // Info: (20261106 - Luphia) 沒有說話時不送聲音封包
    dtx: true,
    red: true,
  },
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

const disconnectMessage = (reason?: DisconnectReason): string => {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'The room owner removed you from the call.';
    case DisconnectReason.ROOM_DELETED:
      return 'The call has ended.';
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined this call from another tab.';
    case DisconnectReason.CLIENT_INITIATED:
    case undefined:
      return '';
    default:
      return 'The call was disconnected.';
  }
};

const mediaErrorMessage = (kind: 'microphone' | 'camera', err: unknown): string => {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError') return `Allow ${kind} access in your browser to use it in the call.`;
  if (name === 'NotFoundError') return `No ${kind} was found.`;
  return `Could not turn on the ${kind}.`;
};

/**
 * Info: (20261106 - Luphia)
 * 房間視訊會議 (共用 LiveKit)：取得入場憑證、連線、離開；Room 只在加入時建立
 */
export function useRoomCall({ roomId, getChatToken, chatReady, pushedParticipants }: IUseRoomCallOptions) {
  const [room, setRoom] = useState<Room | null>(null);
  const [state, setState] = useState<TCallState>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [info, setInfo] = useState<ICallInfo | null>(null);
  const roomRef = useRef<Room | null>(null);
  const tokenRef = useRef(getChatToken);
  useEffect(() => {
    tokenRef.current = getChatToken;
  }, [getChatToken]);

  const fetchStatus = useCallback(async () => {
    const token = tokenRef.current();
    if (!token) return;
    try {
      const res = await fetch(`/api/v1/room/${roomId}/call`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.code === ApiCode.OK && data.payload) setInfo(data.payload as ICallInfo);
    } catch {
      // Info: (20261106 - Luphia) 狀態僅供顯示
    }
  }, [roomId]);

  useEffect(() => {
    if (!chatReady) return;
    const first = setTimeout(fetchStatus, 0);
    const timer = setInterval(fetchStatus, STATUS_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [chatReady, fetchStatus]);

  // Info: (20261106 - Luphia) 離開頁面時結束通話
  useEffect(
    () => () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
    },
    []
  );

  const join = useCallback(
    async (options: { microphone: boolean; camera: boolean }) => {
      if (roomRef.current) return;
      const chatToken = tokenRef.current();
      if (!chatToken) {
        setError('Still connecting to the room. Try again in a moment.');
        return;
      }
      setState('joining');
      setError('');
      setNotice('');
      try {
        const res = await fetch(`/api/v1/room/${roomId}/call/token`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${chatToken}` },
        });
        const data = await res.json();
        if (data.code !== ApiCode.OK) throw new Error(data.message || 'Could not join the call');

        const next = new Room(ROOM_OPTIONS);
        roomRef.current = next;
        next
          .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
          .on(RoomEvent.Reconnected, () => setState('connected'))
          .on(RoomEvent.Disconnected, reason => {
            if (roomRef.current !== next) return;
            roomRef.current = null;
            setRoom(null);
            setState('idle');
            const message = disconnectMessage(reason);
            if (message) setNotice(message);
          });
        await next.connect(data.payload.url, data.payload.token);
        setRoom(next);
        setState('connected');

        const problems: string[] = [];
        if (options.microphone) {
          await next.localParticipant.setMicrophoneEnabled(true).catch(err => problems.push(mediaErrorMessage('microphone', err)));
        }
        if (options.camera) {
          await next.localParticipant.setCameraEnabled(true).catch(err => problems.push(mediaErrorMessage('camera', err)));
        }
        if (problems.length) setNotice(problems.join(' '));
      } catch (err) {
        roomRef.current?.disconnect();
        roomRef.current = null;
        setRoom(null);
        setState('idle');
        setError(err instanceof Error ? err.message : 'Could not join the call');
      }
    },
    [roomId]
  );

  const leave = useCallback(() => {
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setState('idle');
    current?.disconnect();
    fetchStatus();
  }, [fetchStatus]);

  const moderate = useCallback(
    async (identity: string, action: 'mute' | 'remove') => {
      const chatToken = tokenRef.current();
      if (!chatToken) return false;
      try {
        const res = await fetch(`/api/v1/room/${roomId}/call/moderate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${chatToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity, action }),
        });
        const data = await res.json();
        if (data.code !== ApiCode.OK) throw new Error(data.message);
        return true;
      } catch (err) {
        setNotice(err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
        return false;
      }
    },
    [roomId]
  );

  const participants = pushedParticipants ?? info?.participants ?? 0;

  return {
    room,
    state,
    error,
    notice,
    clearNotice: useCallback(() => setNotice(''), []),
    enabled: info?.enabled ?? false,
    participants,
    maxParticipants: info?.maxParticipants ?? 0,
    join,
    leave,
    moderate,
  };
}
