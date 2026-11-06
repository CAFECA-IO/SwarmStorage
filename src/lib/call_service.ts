import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';

/**
 * Info: (20261106 - Luphia)
 * 房間視訊會議：與 Hills 共用自架 LiveKit SFU
 * - DropHere 使用獨立的 API key 與房間名稱前綴 (預設 drophere-)，與 Hills 的房間互不相通
 * - 只有通過房間存取檢查 (持有聊天 token) 的人才能取得 LiveKit 入場憑證
 * - 未設定 LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET 時停用通話
 */

export const CALL_MAX_PARTICIPANTS_DEFAULT = 50;
// Info: (20261106 - Luphia) 入場憑證最長有效期 (只影響加入時的驗證，已在通話中的人不受影響)
const TOKEN_MAX_TTL_SECONDS = 6 * 60 * 60;
// Info: (20261106 - Luphia) 房間沒人後保留的秒數
const EMPTY_TIMEOUT_SECONDS = 5 * 60;
const STATUS_CACHE_MS = 5000;

export interface ICallConfig {
  // Info: (20261106 - Luphia) 伺服器呼叫 LiveKit API 用 (可為內網位址)
  apiUrl: string;
  // Info: (20261106 - Luphia) 瀏覽器連線用 (wss://)
  publicUrl: string;
  apiKey: string;
  apiSecret: string;
  roomPrefix: string;
  maxParticipants: number;
}

export interface ICallParticipant {
  identity: string;
  name: string;
}

const toHttp = (url: string) => url.replace(/^ws(s?):\/\//, 'http$1://');
const toWs = (url: string) => url.replace(/^http(s?):\/\//, 'ws$1://');

export function getCallConfig(): ICallConfig | null {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  const max = Number(process.env.CALL_MAX_PARTICIPANTS);
  return {
    apiUrl: toHttp(url),
    publicUrl: toWs(process.env.LIVEKIT_PUBLIC_URL?.trim() || url),
    apiKey,
    apiSecret,
    roomPrefix: process.env.LIVEKIT_ROOM_PREFIX?.trim() || 'drophere-',
    maxParticipants: Number.isInteger(max) && max > 0 ? Math.min(max, 500) : CALL_MAX_PARTICIPANTS_DEFAULT,
  };
}

const globalForCall = globalThis as unknown as {
  callState?: {
    client: RoomServiceClient | null;
    clientKey: string;
    status: Map<string, { at: number; participants: number }>;
  };
};
const state = (globalForCall.callState ??= { client: null, clientKey: '', status: new Map() });

const clientFor = (config: ICallConfig) => {
  const key = `${config.apiUrl}|${config.apiKey}`;
  if (!state.client || state.clientKey !== key) {
    state.client = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret);
    state.clientKey = key;
  }
  return state.client;
};

export const callRoomName = (config: ICallConfig, roomId: string) => `${config.roomPrefix}${roomId}`;

// Info: (20261106 - Luphia) 由 LiveKit 房間名稱取回 DropHere 房號；不是本服務的房間時回傳 null
export const roomIdFromCallRoom = (config: ICallConfig, name: string | undefined): string | null => {
  if (!name?.startsWith(config.roomPrefix)) return null;
  const roomId = name.slice(config.roomPrefix.length);
  return /^\d{6}$/.test(roomId) ? roomId : null;
};

export async function listCallParticipants(config: ICallConfig, roomId: string): Promise<ICallParticipant[]> {
  try {
    const list = await clientFor(config).listParticipants(callRoomName(config, roomId));
    return list.map(p => ({ identity: p.identity, name: p.name }));
  } catch {
    // Info: (20261106 - Luphia) 房間尚未建立時 LiveKit 回傳 not found
    return [];
  }
}

export async function callParticipantCount(config: ICallConfig, roomId: string): Promise<number> {
  const cached = state.status.get(roomId);
  if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.participants;
  const participants = (await listCallParticipants(config, roomId)).length;
  state.status.set(roomId, { at: Date.now(), participants });
  return participants;
}

export function invalidateParticipantCount(roomId: string) {
  state.status.delete(roomId);
}

export function setCachedParticipantCount(roomId: string, participants: number) {
  state.status.set(roomId, { at: Date.now(), participants });
}

export type TCallTokenResult =
  | { ok: true; url: string; token: string; identity: string; maxParticipants: number }
  | { ok: false; reason: 'full' };

/**
 * Info: (20261106 - Luphia)
 * 建立 (或沿用) LiveKit 房間並簽發入場憑證
 * identity 使用房間內的匿名代號，同一瀏覽器重複加入時 LiveKit 會以新連線取代舊連線
 */
export async function issueCallToken(
  config: ICallConfig,
  options: { roomId: string; identity: string; name: string; isOwner: boolean; roomExpiresAt: number | null }
): Promise<TCallTokenResult> {
  const room = callRoomName(config, options.roomId);
  const client = clientFor(config);
  await client.createRoom({ name: room, maxParticipants: config.maxParticipants, emptyTimeout: EMPTY_TIMEOUT_SECONDS });

  state.status.delete(options.roomId);
  const participants = await listCallParticipants(config, options.roomId);
  if (participants.length >= config.maxParticipants && !participants.some(p => p.identity === options.identity)) {
    return { ok: false, reason: 'full' };
  }

  const remaining = options.roomExpiresAt ? Math.floor((options.roomExpiresAt - Date.now()) / 1000) : TOKEN_MAX_TTL_SECONDS;
  const ttl = Math.max(60, Math.min(TOKEN_MAX_TTL_SECONDS, remaining));
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: options.identity,
    name: options.name,
    ttl,
    metadata: JSON.stringify({ isOwner: options.isOwner }),
  });
  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // Info: (20261106 - Luphia) 文字訊息走房間聊天，不開放 LiveKit data channel
    canPublishData: false,
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  return { ok: true, url: config.publicUrl, token: await token.toJwt(), identity: options.identity, maxParticipants: config.maxParticipants };
}

/**
 * Info: (20261106 - Luphia)
 * 房主管理：關閉某人的麥克風 / 請某人離開通話
 */
export async function moderateCall(
  config: ICallConfig,
  roomId: string,
  identity: string,
  action: 'mute' | 'remove'
): Promise<boolean> {
  const client = clientFor(config);
  const room = callRoomName(config, roomId);
  try {
    if (action === 'remove') {
      await client.removeParticipant(room, identity);
      return true;
    }
    const participant = await client.getParticipant(room, identity);
    const mics = participant.tracks.filter(t => t.source === TrackSource.MICROPHONE && !t.muted);
    await Promise.all(mics.map(t => client.mutePublishedTrack(room, identity, t.sid, true)));
    return true;
  } catch {
    return false;
  }
}

// Info: (20261106 - Luphia) 房間到期或刪除時結束通話 (失敗不影響房間清理)
export async function endCall(roomId: string) {
  const config = getCallConfig();
  if (!config) return;
  state.status.delete(roomId);
  try {
    await clientFor(config).deleteRoom(callRoomName(config, roomId));
  } catch {
    // Info: (20261106 - Luphia) 房間不存在或 LiveKit 暫時無法連線
  }
}

/**
 * Info: (20261106 - Luphia)
 * LiveKit 只能設定一組 webhook 簽章金鑰；共用伺服器時可另設 LIVEKIT_WEBHOOK_API_KEY / SECRET
 * (DropHere 與 Hills 都持有)，未設定時使用 DropHere 自己的 API key
 */
export async function receiveWebhook(config: ICallConfig, body: string, authHeader: string | null) {
  const key = process.env.LIVEKIT_WEBHOOK_API_KEY?.trim() || config.apiKey;
  const secret = process.env.LIVEKIT_WEBHOOK_API_SECRET?.trim() || config.apiSecret;
  return new WebhookReceiver(key, secret).receive(body, authHeader ?? undefined);
}
