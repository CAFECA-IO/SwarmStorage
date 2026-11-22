import { useEffect, useSyncExternalStore } from 'react';
import { ApiCode } from '@/lib/status';
import type { TOwnerEvent, TOwnerNotice } from '@/lib/owner_earnings';

/**
 * Info: (20261122 - Luphia)
 * 房主通知 (瀏覽器端，整個分頁共用一份)：
 * - 讀取通知清單；有付費房時以 SSE 接收新銷售
 * - 新銷售：頁面內提示 (toast)、提示音 (選用)、分頁在背景時送出瀏覽器通知 (選用)
 * - 首頁的桌面版與手機版各有一個鈴鐺，因此狀態放在模組層級，連線只開一條
 */

export type TSaleNotice = Extract<TOwnerNotice, { kind: 'sale' }>;

export interface IOwnerNoticeState {
  loaded: boolean;
  active: boolean;
  unread: number;
  seenAt: number;
  received30: number;
  notices: TOwnerNotice[];
  toasts: TSaleNotice[];
  prefs: { browser: boolean; sound: boolean };
  permission: NotificationPermission | 'unsupported';
}

const PREFS_STORAGE = 'drophere.ownerNotify';
const REFRESH_MS = 10 * 60 * 1000;
const FOCUS_REFRESH_MS = 30 * 1000;
const TOAST_MS = 8000;
export const SALE_EVENT = 'drophere:sale';

const readPrefs = (): IOwnerNoticeState['prefs'] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFS_STORAGE) || '{}') as Partial<IOwnerNoticeState['prefs']>;
    return { browser: parsed.browser === true, sound: parsed.sound === true };
  } catch {
    return { browser: false, sound: false };
  }
};

const currentPermission = (): IOwnerNoticeState['permission'] => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

const EMPTY: IOwnerNoticeState = {
  loaded: false,
  active: false,
  unread: 0,
  seenAt: 0,
  received30: 0,
  notices: [],
  toasts: [],
  prefs: { browser: false, sound: false },
  permission: 'unsupported',
};

let state: IOwnerNoticeState = EMPTY;
const listeners = new Set<() => void>();
let users = 0;
let source: EventSource | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastRefresh = 0;
let nextId = 1;

function setState(patch: Partial<IOwnerNoticeState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

async function refresh() {
  lastRefresh = Date.now();
  try {
    const res = await fetch(`/api/v1/me/notifications?tz=${new Date().getTimezoneOffset()}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.code !== ApiCode.OK) return;
    const payload = data.payload as Pick<IOwnerNoticeState, 'active' | 'unread' | 'seenAt' | 'received30' | 'notices'>;
    setState({ ...payload, loaded: true });
    if (payload.active) openStream();
    else closeStream();
  } catch {
    // Info: (20261122 - Luphia) 暫時連不上：下次再讀
  }
}

// Info: (20261122 - Luphia) 很短的提示音 (不需要音檔)
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + 0.5);
    });
    setTimeout(() => ctx.close().catch(() => undefined), 800);
  } catch {
    // Info: (20261122 - Luphia) 瀏覽器不允許播放：略過
  }
}

export const saleText = (n: TSaleNotice, amount: string) => `${n.buyerName ?? 'Someone'} bought access to ${n.roomName} · +${amount} ${n.token}`;

function onSale(notice: TSaleNotice, amount: string) {
  if (state.notices.some(n => n.id === notice.id)) return;
  setState({
    notices: [notice, ...state.notices],
    unread: state.unread + 1,
    received30: state.received30 + notice.amount,
    toasts: [...state.toasts.slice(-2), notice],
  });
  setTimeout(() => dismissToast(notice.id), TOAST_MS);
  window.dispatchEvent(new CustomEvent(SALE_EVENT, { detail: notice }));
  if (document.visibilityState === 'visible') {
    if (state.prefs.sound) chime();
    return;
  }
  // Info: (20261122 - Luphia) 分頁在背景：瀏覽器通知 (同一筆銷售在多個分頁只會留下一則，tag 相同)
  if (state.prefs.browser && currentPermission() === 'granted') {
    try {
      const n = new Notification(`New sale · +${amount} ${notice.token}`, { body: `${notice.buyerName ?? 'Someone'} unlocked ${notice.roomName}`, tag: notice.id, icon: '/favicon.ico' });
      n.onclick = () => {
        window.focus();
        window.location.href = '/earnings';
      };
    } catch {
      // Info: (20261122 - Luphia) 部分手機瀏覽器只允許從 Service Worker 通知
    }
  }
}

let formatAmountRef: ((micro: number) => string) | null = null;

function openStream() {
  if (source || users === 0) return;
  source = new EventSource('/api/v1/me/events');
  source.onmessage = e => {
    try {
      const event = JSON.parse(e.data) as TOwnerEvent;
      if (event.type === 'sale') onSale(event.notice, formatAmountRef ? formatAmountRef(event.notice.amount) : String(event.notice.amount));
    } catch {
      // Info: (20261122 - Luphia) 格式不符：略過
    }
  };
  source.onerror = () => {
    // Info: (20261122 - Luphia) 被伺服器拒絕 (例如登入過期) 時不會自動重連：稍後重新讀取狀態
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      setTimeout(() => {
        if (users > 0) refresh();
      }, 30000);
    }
  };
}

function closeStream() {
  source?.close();
  source = null;
}

const onVisible = () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRefresh > FOCUS_REFRESH_MS) refresh();
};

function start(formatAmount: (micro: number) => string) {
  formatAmountRef = formatAmount;
  users += 1;
  if (users > 1) return;
  setState({ prefs: readPrefs(), permission: currentPermission() });
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', onVisible);
}

function stop() {
  users -= 1;
  if (users > 0) return;
  closeStream();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
}

// Info: (20261122 - Luphia) 房主改了付費設定或延長房間後重新讀取 (沒有鈴鐺時不做事)
export function refreshOwnerNotices() {
  if (users > 0) refresh();
}

export function dismissToast(id: string) {
  if (state.toasts.some(t => t.id === id)) setState({ toasts: state.toasts.filter(t => t.id !== id) });
}

export async function markAllSeen() {
  setState({ unread: 0, seenAt: Date.now() });
  try {
    const res = await fetch('/api/v1/me/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'seen' }) });
    const data = await res.json();
    if (data.code === ApiCode.OK) setState({ seenAt: data.payload.seenAt });
  } catch {
    // Info: (20261122 - Luphia) 下次重新讀取時會再同步
  }
}

function savePrefs(prefs: IOwnerNoticeState['prefs']) {
  setState({ prefs });
  try {
    window.localStorage.setItem(PREFS_STORAGE, JSON.stringify(prefs));
  } catch {
    // Info: (20261122 - Luphia) 只保留在記憶體
  }
}

// Info: (20261122 - Luphia) 開啟瀏覽器通知需要使用者同意 (必須在點擊事件中呼叫)
export async function setBrowserNotify(on: boolean) {
  if (!on) {
    savePrefs({ ...state.prefs, browser: false });
    return;
  }
  if (typeof Notification === 'undefined') return;
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  setState({ permission });
  savePrefs({ ...state.prefs, browser: permission === 'granted' });
}

export function setSound(on: boolean) {
  savePrefs({ ...state.prefs, sound: on });
  if (on) chime();
}

// Info: (20261122 - Luphia) 新銷售提示只由一個鈴鐺顯示 (首頁同時掛著桌面版與手機版)；先掛上的優先，卸載後交給下一個
let hosts: number[] = [];
export function claimToastHost(): number {
  const id = nextId++;
  hosts = [...hosts, id];
  setState({});
  return id;
}
export function releaseToastHost(id: number) {
  hosts = hosts.filter(h => h !== id);
  setState({});
}
export const isToastHost = (id: number | null) => id !== null && hosts[0] === id;

export function useOwnerNotices(enabled: boolean, formatAmount: (micro: number) => string): IOwnerNoticeState {
  useEffect(() => {
    if (!enabled) return;
    start(formatAmount);
    return stop;
  }, [enabled, formatAmount]);
  const snapshot = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  return enabled ? snapshot : EMPTY;
}
