import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  downloadFromMetadata,
  isDownloadAllowed,
  repairFile,
  type ILariaMetadata,
  type IShardStats,
} from '@/lib/file_operator';
import type { IHtmlOutlineItem, IHtmlPreviewOptions, IPreparedHtml, IRoomFileResolver } from '@/lib/html_preview';
import {
  FILE_GROUP_LABELS,
  FILE_KIND_DOT,
  getFileGroup,
  getFileKind,
  guessMimeType,
  isRenderedDocument,
  type TFileGroup,
} from '@/lib/file_types';
import { formatBytes } from '@/lib/utils';
import { ApiCode } from '@/lib/status';
import { ClockIcon, LockIcon, VideoIcon, XIcon } from '@/components/icons';
import { RoomAudioRenderer, RoomContext } from '@livekit/components-react';
import { CallJoinPanel, CallMiniBar, CallStage } from '@/components/room_call';
import { useRoomCall } from '@/lib/use_room_call';
import FilePreviewPane, { type IFileLoadState, type TViewMode } from '@/components/file_preview_pane';
import FileInspector, { type IRepairState } from '@/components/file_inspector';
import RoomChat from '@/components/room_chat';
import RoomActivity from '@/components/room_activity';
import RoomSettingsPanel from '@/components/room_settings_panel';
import AccountButton from '@/components/account_button';
import type { IFileAction } from '@/components/file_actions_menu';
import { useRoomChat } from '@/lib/use_room_chat';
import { useRoomUploader } from '@/lib/use_room_uploader';
import { collectDropped, collectPicked, type ICollectedFiles, type IPathedFile } from '@/lib/folder_entries';
import { baseName, filesUnder, freeTopName, listChildren, topLevelNames } from '@/lib/folder_tree';
import { chooseZipTarget, downloadFolderZip, zipNameOf } from '@/lib/folder_zip';
import { FolderIcon, percentOf } from '@/components/folder_browser';
import { addRecentRoom, memberHeaders } from '@/lib/member';
import type { IRoomSettings } from '@/lib/room_store';
import type { IHtmlViewerHandle } from '@/components/html_viewer';

interface IRoomWorkspaceProps {
  roomId: string;
  initialPassword?: string;
  initialFile?: string;
  onExit: () => void;
}

// Info: (20261105 - Luphia) 開啟分頁時自動載入預覽的大小上限
const AUTO_PREVIEW_LIMIT = 50 * 1024 * 1024;
// Info: (20261105 - Luphia) HTML / 文字檔以文字讀入的大小上限
const TEXT_PREVIEW_LIMIT = 20 * 1024 * 1024;

const DEFAULT_PREVIEW_OPTIONS: IHtmlPreviewOptions = {
  allowScripts: false,
  allowExternal: false,
  resolveRoomFiles: true,
};

const GROUP_ORDER: TFileGroup[] = ['documents', 'media', 'other'];

// Info: (20261106 - Luphia) 刪除後可復原的時間 (與伺服器 DELETE_UNDO_MS 相同)
const DELETE_UNDO_MS = 10000;

type TSidePanelTab = 'details' | 'chat' | 'settings';

interface IToast {
  id: string;
  message: string;
  tone: 'success' | 'info' | 'error';
  actionLabel?: string;
  onAction?: () => void;
}

const formatRemaining = (ms: number): string => {
  if (ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `Expires in ${days} d ${hours} h`;
  if (hours > 0) return `Expires in ${hours} h ${minutes % 60} min`;
  return `Expires in ${Math.max(minutes, 1)} min`;
};

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Info: (20261105 - Luphia)
 * 房間檔案瀏覽器 (C 方案：閱讀工作區)
 * - 左：依類型分組的檔案清單 + 目前 HTML 文件的目錄
 * - 中：分頁、路徑 / 頁內搜尋 / 檢視模式工具列、預覽
 * - 右：檔案資訊、儲存健康度、預覽安全開關
 */
export default function RoomWorkspace({ roomId, initialPassword, initialFile, onExit }: IRoomWorkspaceProps) {
  const [files, setFiles] = useState<ILariaMetadata[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState(initialPassword || '');
  const [passwordError, setPasswordError] = useState('');

  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [loads, setLoads] = useState<Record<string, IFileLoadState>>({});
  const [shardStats, setShardStats] = useState<Record<string, IShardStats>>({});
  const [outlines, setOutlines] = useState<Record<string, IHtmlOutlineItem[]>>({});
  const [inlinedFiles, setInlinedFiles] = useState<Record<string, string[]>>({});
  const [activeHeading, setActiveHeading] = useState('');
  const [viewMode, setViewMode] = useState<TViewMode>('reading');
  const [previewOptions, setPreviewOptions] = useState<IHtmlPreviewOptions>(DEFAULT_PREVIEW_OPTIONS);
  const [findQuery, setFindQuery] = useState('');
  const [findStatus, setFindStatus] = useState<'idle' | 'found' | 'missing'>('idle');
  const [findPosition, setFindPosition] = useState({ index: 0, total: 0 });
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [linkCopied, setLinkCopied] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settings, setSettings] = useState<IRoomSettings | null>(null);
  // Info: (20261105 - Luphia) 伺服器時間 - 本機時間，修正時鐘誤差
  const [clockOffset, setClockOffset] = useState(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // Info: (20261108 - Luphia) 資料夾 (C 方案)：瀏覽中的資料夾、待確認的資料夾上傳、打包下載進度
  const [browse, setBrowse] = useState<{ path: string; selected: string | null } | null>(null);
  const [pendingDrop, setPendingDrop] = useState<{
    entries: IPathedFile[];
    folders: { name: string; original: string; count: number; size: number }[];
    looseCount: number;
    skipped: number;
    truncated: boolean;
  } | null>(null);
  const [zipJob, setZipJob] = useState<{ name: string; done: number; total: number } | null>(null);
  const [now, setNow] = useState(0);
  const [repairs, setRepairs] = useState<Record<string, IRepairState>>({});
  // Info: (20261105 - Luphia) 聊天：通過密碼驗證後才連線
  const [chatEnabled, setChatEnabled] = useState(false);
  const [chatPassword, setChatPassword] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<TSidePanelTab>('details');
  const [seenMessages, setSeenMessages] = useState(0);

  const viewerRef = useRef<IHtmlViewerHandle>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<ILariaMetadata[]>([]);
  const blobPromises = useRef(new Map<string, Promise<Blob>>());
  const objectUrls = useRef<string[]>([]);

  // Info: (20261105 - Luphia) 即時上傳：進房後新增的檔案、想被通知的上傳、完成提示
  const [newFiles, setNewFiles] = useState<Record<string, number>>({});
  const [watching, setWatching] = useState<Set<string>>(() => new Set());
  const [toasts, setToasts] = useState<IToast[]>([]);
  const watchingRef = useRef(watching);
  useEffect(() => {
    watchingRef.current = watching;
  }, [watching]);

  const dismissToast = (id: string) => setToasts(prev => prev.filter(t => t.id !== id));
  const pushToast = (toast: Omit<IToast, 'id'>, duration = 10000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts(prev => [...prev.slice(-3), { ...toast, id }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    return id;
  };

  /**
   * Info: (20261105 - Luphia)
   * 房間新增 / 更新檔案 (由伺服器即時推送)：更新清單；新上傳會清除同名檔案的快取
   */
  const handleFileEvent = (raw: Record<string, unknown>, uploadId: string | null) => {
    const metadata = raw as unknown as ILariaMetadata;
    if (typeof metadata.filename !== 'string' || !Array.isArray(metadata.shards)) return;
    const name = metadata.filename;

    if (uploadId) {
      blobPromises.current.delete(name);
      setLoads(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setShardStats(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setNewFiles(prev => ({ ...prev, [name]: Date.now() }));
    }

    const list = [...filesRef.current.filter(f => f.filename !== name), metadata].sort((a, b) => a.filename.localeCompare(b.filename));
    filesRef.current = list;
    setFiles(list);

    // Info: (20261105 - Luphia) 正在檢視的檔案被重新上傳：載入新版本
    if (uploadId && activeNameRef.current === name) loadBlob(name).catch(() => undefined);

    if (uploadId && watchingRef.current.has(uploadId)) {
      setWatching(prev => {
        const next = new Set(prev);
        next.delete(uploadId);
        return next;
      });
      pushToast({ message: `${name} is ready`, tone: 'success', actionLabel: 'Open', onAction: () => openFile(name) });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        new Notification(`${name} is ready`, { body: `Room #${roomId}` });
      }
    }
  };

  /**
   * Info: (20261106 - Luphia)
   * 檔案被刪除 (由伺服器即時推送)：移出清單、關閉分頁並清除快取
   */
  const handleFileRemoved = (name: string) => {
    const list = filesRef.current.filter(f => f.filename !== name);
    filesRef.current = list;
    setFiles(list);
    blobPromises.current.delete(name);
    setOpenTabs(prev => prev.filter(n => n !== name));
    if (activeNameRef.current === name) {
      setActiveName(null);
      setActiveHeading('');
    }
    setNewFiles(prev => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  // Info: (20261106 - Luphia) 房主變更設定：更新公開欄位，保留自己的身分資訊
  const handleRoomSettings = (raw: Record<string, unknown>) => {
    setSettings(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...(raw as Partial<IRoomSettings>), isOwner: prev.isOwner, myUploaderId: prev.myUploaderId, serverTime: prev.serverTime };
      next.canUpload = prev.isOwner || next.uploadPolicy === 'everyone';
      return next;
    });
  };

  const chat = useRoomChat({
    roomId,
    password: chatPassword,
    enabled: chatEnabled,
    onFile: handleFileEvent,
    onFileRemoved: handleFileRemoved,
    onRoomSettings: handleRoomSettings,
    onUploadComplete: upload => handleBundleComplete(upload.uploadId, upload.filename, upload.filesTotal ?? 0),
  });

  // Info: (20261106 - Luphia) 視訊會議 (共用 LiveKit)；callOpen 表示主畫面顯示通話
  const call = useRoomCall({
    roomId,
    getChatToken: chat.getToken,
    chatReady: chat.status === 'connected',
    pushedParticipants: chat.callParticipants,
  });
  const [callOpen, setCallOpen] = useState(false);
  const inCall = call.room !== null;

  const pushToastRef = useRef(pushToast);
  useEffect(() => {
    pushToastRef.current = pushToast;
  });
  const handleUploadError = useCallback((message: string) => pushToastRef.current({ message, tone: 'error' }), []);
  // Info: (20261108 - Luphia) 取消上傳的結果提示
  const handleUploadCancelled = useCallback((name: string, result: { kept: number; removed: number; failedToRemove: number }) => {
    const detail = result.kept
      ? ` · kept ${result.kept} uploaded ${result.kept === 1 ? 'file' : 'files'}`
      : result.removed
        ? ` · removed ${result.removed} uploaded ${result.removed === 1 ? 'file' : 'files'}`
        : '';
    pushToastRef.current(
      result.failedToRemove
        ? { message: `Upload of ${name} cancelled · ${result.failedToRemove} uploaded files could not be removed`, tone: 'error' }
        : { message: `Upload of ${name} cancelled${detail}`, tone: 'info' },
      4000
    );
  }, []);
  const handleUploadPaused = useCallback(
    (name: string, reason: string) =>
      pushToastRef.current({ message: `Upload of ${name} paused: ${reason}. It resumes when you press Resume or the connection comes back.`, tone: 'error' }, 6000),
    []
  );
  const uploader = useRoomUploader({
    roomId,
    password: chatPassword,
    allowDownload: settings?.allowDownload ?? true,
    chat,
    onError: handleUploadError,
    onCancelled: handleUploadCancelled,
    onPaused: handleUploadPaused,
  });
  const uploadFiles = uploader.upload;
  // Info: (20261108 - Luphia) 取消資料夾上傳前的確認 (保留或刪除已完成的檔案)
  const [cancelAsk, setCancelAsk] = useState<{ uploadId: string; name: string; done: number; total: number } | null>(null);
  const requestCancel = (upload: { uploadId: string; filename: string; kind?: string; filesDone?: number; filesTotal?: number }) => {
    if (upload.kind !== 'folder' || !upload.filesDone) {
      uploader.cancel(upload.uploadId);
      return;
    }
    setCancelAsk({ uploadId: upload.uploadId, name: upload.filename, done: upload.filesDone, total: upload.filesTotal ?? 0 });
  };

  // Info: (20261108 - Luphia) 資料夾上傳包完成：通知有按「Notify me」的人
  function handleBundleComplete(uploadId: string, folder: string, count: number) {
    if (!watchingRef.current.has(uploadId)) return;
    setWatching(prev => {
      const next = new Set(prev);
      next.delete(uploadId);
      return next;
    });
    pushToast({
      message: `${folder} is ready (${count} files)`,
      tone: 'success',
      actionLabel: 'Browse',
      onAction: () => {
        setActiveName(null);
        setCallOpen(false);
        setBrowse({ path: folder, selected: null });
      },
    });
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      new Notification(`${folder} is ready`, { body: `Room #${roomId} · ${count} files` });
    }
  }

  const toggleWatch = (uploadId: string) => {
    const adding = !watching.has(uploadId);
    setWatching(prev => {
      const next = new Set(prev);
      if (adding) next.add(uploadId);
      else next.delete(uploadId);
      return next;
    });
    if (adding && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => undefined);
    }
  };
  const othersMessageCount = chat.entries.filter(e => e.kind === 'message' && e.message.memberId !== chat.me?.memberId).length;
  const othersCountRef = useRef(0);
  const activeNameRef = useRef<string | null>(null);
  useEffect(() => {
    othersCountRef.current = othersMessageCount;
  }, [othersMessageCount]);
  useEffect(() => {
    activeNameRef.current = activeName;
  }, [activeName]);

  // Info: (20261105 - Luphia) 釋放預覽用的 object URL
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, []);

  /**
   * Info: (20261105 - Luphia)
   * 下載並快取檔案內容；同一檔案只會下載一次 (預覽、下載與 HTML 內嵌資源共用)
   */
  const loadBlob = useCallback((name: string): Promise<Blob> => {
    const cached = blobPromises.current.get(name);
    if (cached) return cached;
    const meta = filesRef.current.find(f => f.filename === name);
    if (!meta) return Promise.reject(new Error(`File not found: ${name}`));

    setLoads(prev => ({ ...prev, [name]: { status: 'loading', progress: 0 } }));
    const promise = new Promise<Blob>((resolve, reject) => {
      downloadFromMetadata(meta, {
        onProgress: progress =>
          setLoads(prev => (prev[name]?.status === 'loading' ? { ...prev, [name]: { ...prev[name], progress } } : prev)),
        onShardStats: stats => setShardStats(prev => ({ ...prev, [name]: stats })),
        onSuccess: async raw => {
          const kind = getFileKind(name, meta.mimeType);
          const blob = new Blob([raw], { type: guessMimeType(name, meta.mimeType) });
          const state: IFileLoadState = { status: 'ready', progress: 100, blob };
          if (kind === 'html' || kind === 'markdown' || kind === 'text') {
            if (blob.size <= TEXT_PREVIEW_LIMIT) state.text = await blob.text();
          } else if (kind !== 'other') {
            state.url = URL.createObjectURL(blob);
            objectUrls.current.push(state.url);
          }
          setLoads(prev => ({ ...prev, [name]: state }));
          resolve(blob);
        },
        onError: error => {
          blobPromises.current.delete(name);
          setLoads(prev => ({ ...prev, [name]: { status: 'error', progress: 0, error } }));
          reject(new Error(error));
        },
      });
    });
    blobPromises.current.set(name, promise);
    return promise;
  }, []);

  const openFile = useCallback(
    (name: string) => {
      const meta = filesRef.current.find(f => f.filename === name);
      if (!meta) return;
      // Info: (20261105 - Luphia) 沒有開啟檔案時側欄顯示聊天；開啟檔案後切到 Details，視為已讀
      if (!activeNameRef.current) setSeenMessages(othersCountRef.current);
      setOpenTabs(prev => (prev.includes(name) ? prev : [...prev, name]));
      setCallOpen(false);
      setActiveName(name);
      setActiveHeading('');
      setFindStatus('idle');
      setNavOpen(false);
      const kind = getFileKind(name, meta.mimeType);
      if (kind !== 'other' && meta.originalFileSize <= AUTO_PREVIEW_LIMIT) {
        loadBlob(name).catch(() => undefined);
      }
    },
    [loadBlob]
  );

  const fetchSettings = useCallback(
    async (passwordValue?: string) => {
      try {
        const res = await fetch(`/api/v1/room/${roomId}/settings`, { headers: memberHeaders({}, passwordValue || null) });
        const data = await res.json();
        if (data.code === ApiCode.OK && data.payload) {
          const localNow = Date.now();
          setSettings(data.payload as IRoomSettings);
          setClockOffset((data.payload.serverTime ?? localNow) - localNow);
          setNow(localNow);
        }
      } catch {
        // Info: (20261106 - Luphia) 設定載入失敗時仍可瀏覽檔案 (無上傳 / 管理功能)
      }
    },
    [roomId]
  );

  // Info: (20261105 - Luphia) 每 10 秒更新時間 (到期倒數、「幾秒前」)
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 10000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const fetchFiles = useCallback(
    async (passwordValue?: string) => {
      try {
        const res = await fetch(`/api/v1/room/${roomId}`, { headers: memberHeaders({}, passwordValue || null) });
        const data = await res.json();

        if (data.code === ApiCode.OK) {
          const list = ([...(data.payload || [])] as ILariaMetadata[]).sort((a, b) => a.filename.localeCompare(b.filename));
          filesRef.current = list;
          setFiles(list);
          setNeedsPassword(false);
          setChatPassword(passwordValue || null);
          setChatEnabled(true);
          setPasswordError('');
          setErrorMessage('');
          if (initialFile && list.some(f => f.filename === initialFile)) openFile(initialFile);
          addRecentRoom(roomId);
          fetchSettings(passwordValue);
        } else if (data.code === ApiCode.UNAUTHORIZED) {
          setNeedsPassword(true);
          if (passwordValue) setPasswordError('Incorrect password');
        } else {
          setErrorMessage(data.message || 'Failed to load room files');
        }
      } catch {
        setErrorMessage('Network error');
      } finally {
        setIsLoading(false);
      }
    },
    [roomId, initialFile, openFile, fetchSettings]
  );

  useEffect(() => {
    const init = async () => {
      await fetchFiles(initialPassword);
    };
    init();
  }, [fetchFiles, initialPassword]);

  const handlePasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    fetchFiles(password);
  };

  const closeTab = (name: string) => {
    const index = openTabs.indexOf(name);
    const next = openTabs.filter(n => n !== name);
    setOpenTabs(next);
    if (activeName === name) {
      setActiveName(next.length ? next[Math.min(index, next.length - 1)] : null);
      setActiveHeading('');
    }
  };

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const nextIndex = (index + (e.key === 'ArrowRight' ? 1 : -1) + openTabs.length) % openTabs.length;
    setActiveName(openTabs[nextIndex]);
    setActiveHeading('');
    document.getElementById(`tab-${nextIndex}`)?.focus();
  };

  const handleDownload = async (name: string) => {
    const meta = filesRef.current.find(f => f.filename === name);
    if (!meta || !isDownloadAllowed(meta)) return;
    const ready = loads[name];
    if (ready?.status === 'ready' && ready.blob) {
      saveBlob(ready.blob, baseName(name));
      return;
    }
    setDownloading(prev => ({ ...prev, [name]: true }));
    try {
      saveBlob(await loadBlob(name), baseName(name));
    } catch {
      // Info: (20261105 - Luphia) 錯誤已寫入 loads 狀態並顯示於預覽區
    } finally {
      setDownloading(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  const handleCopyLink = async (name: string) => {
    const url = `${window.location.origin}/room/${roomId}?file=${encodeURIComponent(name)}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  /**
   * Info: (20261105 - Luphia)
   * 重建遺失分片並更新房間中的 metadata
   */
  const handleRepair = async (name: string) => {
    const meta = filesRef.current.find(f => f.filename === name);
    if (!meta) return;
    setRepairs(prev => ({ ...prev, [name]: { status: 'running', progress: 0 } }));
    try {
      const result = await repairFile(meta, progress =>
        setRepairs(prev => ({ ...prev, [name]: { status: 'running', progress } }))
      );
      if (result.repaired.length > 0) {
        const res = await fetch(`/api/v1/room/${roomId}`, {
          method: 'POST',
          headers: memberHeaders({ 'Content-Type': 'application/json' }, chatPassword),
          body: JSON.stringify(result.metadata),
        });
        const data = await res.json();
        if (data.code !== ApiCode.OK) throw new Error(data.message || 'Failed to save repaired metadata');
        const list = filesRef.current.map(f => (f.filename === name ? result.metadata : f));
        filesRef.current = list;
        setFiles(list);
      }
      setShardStats(prev => ({
        ...prev,
        [name]: { total: meta.shards.length, missingData: 0, missingParity: 0, missing: [], reconstructed: false },
      }));
      setRepairs(prev => ({
        ...prev,
        [name]: {
          status: 'done',
          progress: 100,
          message:
            result.repaired.length > 0
              ? `Rebuilt and re-stored ${result.repaired.length} shard${result.repaired.length > 1 ? 's' : ''}.`
              : 'No missing shards found.',
        },
      }));
    } catch (err) {
      setRepairs(prev => ({
        ...prev,
        [name]: { status: 'error', progress: 0, message: err instanceof Error ? err.message : 'Repair failed' },
      }));
    }
  };

  const myUploaderId = settings?.myUploaderId ?? null;
  const isOwner = settings?.isOwner ?? false;
  const canManageFile = (file: ILariaMetadata) => isOwner || (!!myUploaderId && file.uploaderId === myUploaderId);
  const uploaderLabel = (file: ILariaMetadata) => {
    if (!file.uploaderId) return 'Earlier upload';
    if (myUploaderId && file.uploaderId === myUploaderId) return 'You';
    return file.uploaderName ? `@${file.uploaderName}` : 'Someone else';
  };

  /**
   * Info: (20261106 - Luphia)
   * 刪除檔案：伺服器先移至回收區，10 秒內可復原
   */
  const handleDelete = async (name: string) => {
    try {
      const res = await fetch(`/api/v1/room/${roomId}/files/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: memberHeaders({}, chatPassword),
      });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message || 'Could not delete the file');
      handleFileRemoved(name);
      pushToast(
        {
          message: `${name} was deleted`,
          tone: 'info',
          actionLabel: 'Undo',
          onAction: () => handleRestore(name),
        },
        DELETE_UNDO_MS
      );
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Could not delete the file', tone: 'error' });
    }
  };

  // Info: (20261108 - Luphia) 刪除整個資料夾：逐一刪除 (10 秒內可一次復原)
  const handleDeleteFolder = async (path: string) => {
    const inside = filesUnder(filesRef.current, path);
    const deleted: string[] = [];
    for (const file of inside) {
      try {
        const res = await fetch(`/api/v1/room/${roomId}/files/${encodeURIComponent(file.filename)}`, {
          method: 'DELETE',
          headers: memberHeaders({}, chatPassword),
        });
        const data = await res.json();
        if (data.code === ApiCode.OK) {
          deleted.push(file.filename);
          handleFileRemoved(file.filename);
        }
      } catch {
        // Info: (20261108 - Luphia) 個別失敗：最後一併提示
      }
    }
    if (browse && (browse.path === path || browse.path.startsWith(`${path}/`))) setBrowse(null);
    const failed = inside.length - deleted.length;
    pushToast(
      {
        message: failed ? `${path}: deleted ${deleted.length}, ${failed} could not be deleted` : `${path} was deleted (${deleted.length} files)`,
        tone: failed ? 'error' : 'info',
        actionLabel: deleted.length ? 'Undo' : undefined,
        onAction: deleted.length
          ? async () => {
              let restored = 0;
              for (const name of deleted) {
                try {
                  const res = await fetch(`/api/v1/room/${roomId}/files/${encodeURIComponent(name)}/restore`, {
                    method: 'POST',
                    headers: memberHeaders({}, chatPassword),
                  });
                  if ((await res.json()).code === ApiCode.OK) restored++;
                } catch {
                  // Info: (20261108 - Luphia) ignore
                }
              }
              pushToast({ message: `${path}: restored ${restored} of ${deleted.length} files`, tone: restored === deleted.length ? 'success' : 'error' }, 4000);
            }
          : undefined,
      },
      DELETE_UNDO_MS
    );
  };

  /**
   * Info: (20261108 - Luphia)
   * 下載整個資料夾 (.zip)：先開啟儲存對話框 (必須在點擊事件中)，再逐一取回檔案打包
   */
  const handleDownloadFolder = async (path: string) => {
    if (zipJob) {
      pushToast({ message: 'Another folder is being zipped. Try again when it finishes.', tone: 'error' }, 4000);
      return;
    }
    const zipName = zipNameOf(path);
    const target = await chooseZipTarget(zipName);
    if (target.kind === 'cancelled') return;
    const inside = filesUnder(filesRef.current, path);
    setZipJob({ name: zipName, done: 0, total: inside.length });
    try {
      const result = await downloadFolderZip(path, inside, target, progress => setZipJob({ name: zipName, done: progress.done, total: progress.total }));
      if (result.blob) saveBlob(result.blob, zipName);
      const notes = [
        result.skipped ? `${result.skipped} view-only ${result.skipped === 1 ? 'file was' : 'files were'} left out` : '',
        result.failed ? `${result.failed} could not be downloaded` : '',
      ].filter(Boolean);
      pushToast({ message: `${zipName} is ready${notes.length ? ` · ${notes.join(' · ')}` : ''}`, tone: result.failed ? 'error' : 'success' }, 6000);
    } catch (err) {
      pushToast({ message: err instanceof Error ? `${zipName}: ${err.message}` : `Could not create ${zipName}`, tone: 'error' });
    } finally {
      setZipJob(null);
    }
  };

  const handleRestore = async (name: string) => {
    try {
      const res = await fetch(`/api/v1/room/${roomId}/files/${encodeURIComponent(name)}/restore`, {
        method: 'POST',
        headers: memberHeaders({}, chatPassword),
      });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message || 'Could not restore the file');
      pushToast({ message: `${name} was restored`, tone: 'success' }, 4000);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Could not restore the file', tone: 'error' });
    }
  };

  // Info: (20261106 - Luphia) 上傳者 / 房主切換單一檔案的下載權限
  const handleToggleDownload = async (name: string, allow: boolean) => {
    const meta = filesRef.current.find(f => f.filename === name);
    if (!meta) return;
    try {
      const res = await fetch(`/api/v1/room/${roomId}`, {
        method: 'POST',
        headers: memberHeaders({ 'Content-Type': 'application/json' }, chatPassword),
        body: JSON.stringify({ ...meta, allowDownload: allow }),
      });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message || 'Could not change downloads');
      const saved = (data.payload?.metadata as ILariaMetadata) || { ...meta, allowDownload: allow };
      const list = filesRef.current.map(f => (f.filename === name ? saved : f));
      filesRef.current = list;
      setFiles(list);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'Could not change downloads', tone: 'error' });
    }
  };

  const getFileActions = (file: ILariaMetadata): IFileAction[] => {
    const actions: IFileAction[] = [{ label: 'Open', onSelect: () => openFile(file.filename) }];
    if (isDownloadAllowed(file)) actions.push({ label: 'Download', onSelect: () => handleDownload(file.filename) });
    actions.push({ label: 'Copy link', onSelect: () => handleCopyLink(file.filename) });
    if (canManageFile(file)) {
      const allowed = isDownloadAllowed(file);
      actions.push({
        label: allowed ? 'Turn off downloads' : 'Turn on downloads',
        onSelect: () => handleToggleDownload(file.filename, !allowed),
      });
      actions.push({ label: 'Delete from room', onSelect: () => handleDelete(file.filename), danger: true });
    }
    return actions;
  };

  const getFolderActions = (path: string): IFileAction[] => {
    const inside = filesUnder(files || [], path);
    const actions: IFileAction[] = [
      {
        label: 'Browse',
        onSelect: () => {
          setActiveName(null);
          setBrowse({ path, selected: null });
        },
      },
      { label: 'Download all · .zip', onSelect: () => handleDownloadFolder(path) },
    ];
    // Info: (20261108 - Luphia) 上傳中的資料夾不能刪除 (等上傳包完成)
    const top = path.split('/')[0];
    const stillUploading = chat.uploads.some(u => u.kind === 'folder' && u.filename === top);
    if (!stillUploading && inside.length > 0 && inside.every(canManageFile)) {
      actions.push({ label: 'Delete folder', onSelect: () => handleDeleteFolder(path), danger: true });
    }
    return actions;
  };

  /**
   * Info: (20261108 - Luphia)
   * 上傳前整理：同名的第一層資料夾自動改名「名稱 (2)」；有資料夾時先請使用者確認
   */
  const prepareUpload = (collected: ICollectedFiles) => {
    if (collected.files.length === 0) {
      if (collected.skipped) pushToast({ message: 'Nothing to upload (only system files were found).', tone: 'error' }, 4000);
      return;
    }
    if (!settings?.canUpload) {
      pushToast({ message: 'Only the room owner can add files here.', tone: 'error' });
      return;
    }
    const taken = topLevelNames([...(files || []).map(f => f.filename), ...chat.uploads.map(u => u.filename)]);
    const renames = new Map<string, string>();
    const folders = new Map<string, { name: string; original: string; count: number; size: number }>();
    const entries = collected.files.map(entry => {
      const slash = entry.path.indexOf('/');
      if (slash < 0) return entry;
      const original = entry.path.slice(0, slash);
      let name = renames.get(original);
      if (!name) {
        name = freeTopName(original, taken);
        taken.add(name);
        renames.set(original, name);
      }
      const summary = folders.get(name) ?? { name, original, count: 0, size: 0 };
      summary.count += 1;
      summary.size += entry.file.size;
      folders.set(name, summary);
      return { file: entry.file, path: `${name}${entry.path.slice(slash)}` };
    });
    if (folders.size === 0) {
      uploadFiles(entries);
      return;
    }
    setPendingDrop({
      entries,
      folders: [...folders.values()],
      looseCount: entries.filter(e => !e.path.includes('/')).length,
      skipped: collected.skipped,
      truncated: collected.truncated,
    });
  };

  const handleSettingsChange = async (patch: Record<string, unknown>) => {
    setSettingsSaving(true);
    setSettingsError('');
    try {
      const res = await fetch(`/api/v1/room/${roomId}/settings`, {
        method: 'PATCH',
        headers: memberHeaders({ 'Content-Type': 'application/json' }, chatPassword),
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.code !== ApiCode.OK) throw new Error(data.message || 'Could not save settings');
      if (data.payload) {
        const localNow = Date.now();
        setSettings(data.payload as IRoomSettings);
        setClockOffset((data.payload.serverTime ?? localNow) - localNow);
      }
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setSettingsSaving(false);
    }
  };

  const handlePickedFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    prepareUpload(collectPicked(list));
  };

  const runFind = (backwards = false) => {
    if (!findQuery.trim()) return;
    viewerRef.current?.find(findQuery, backwards);
  };

  const resolver = useMemo<IRoomFileResolver>(
    () => ({
      filenames: (files || []).map(f => f.filename),
      load: loadBlob,
      sizeOf: (name: string) => files?.find(f => f.filename === name)?.originalFileSize ?? Number.POSITIVE_INFINITY,
    }),
    [files, loadBlob]
  );

  const handleOutline = useCallback(
    (outline: IHtmlOutlineItem[]) => {
      if (activeName) setOutlines(prev => ({ ...prev, [activeName]: outline }));
    },
    [activeName]
  );

  const handlePrepared = useCallback(
    (prepared: IPreparedHtml) => {
      if (activeName) setInlinedFiles(prev => ({ ...prev, [activeName]: prepared.inlinedFiles }));
    },
    [activeName]
  );

  const handleFindResult = useCallback((result: { found: boolean; index: number; total: number }) => {
    setFindStatus(result.found ? 'found' : 'missing');
    setFindPosition({ index: result.index, total: result.total });
  }, []);

  // Info: (20261108 - Luphia) 左側清單：第一層資料夾 + 不在資料夾中的檔案 (依類型分組)
  const rootListing = useMemo(() => listChildren(files || [], ''), [files]);
  const groups = useMemo(() => {
    const result: Record<TFileGroup, ILariaMetadata[]> = { documents: [], media: [], other: [] };
    rootListing.files.forEach(f => result[getFileGroup(getFileKind(f.filename, f.mimeType))].push(f));
    return result;
  }, [rootListing]);

  // Info: (20261105 - Luphia) 尚未完成的上傳也列在檔案清單中 (不可點選)
  const pendingUploads = chat.uploads.filter(u => !(files || []).some(f => f.filename === u.filename));
  const pendingFolders = pendingUploads.filter(u => u.kind === 'folder' && !rootListing.folders.some(f => f.name === u.filename));
  const uploadGroups = useMemo(() => {
    const result: Record<TFileGroup, typeof pendingUploads> = { documents: [], media: [], other: [] };
    pendingUploads.filter(u => u.kind !== 'folder' && !u.filename.includes('/')).forEach(u => result[getFileGroup(getFileKind(u.filename, u.mimeType))].push(u));
    return result;
  }, [pendingUploads]);
  const thumbnails = useMemo(() => {
    const result: Record<string, string> = {};
    (files || []).forEach(f => {
      const url = loads[f.filename]?.url;
      if (url && getFileKind(f.filename, f.mimeType) === 'image') result[f.filename] = url;
    });
    return result;
  }, [files, loads]);
  const expiresAt = settings?.expiresAt ?? null;
  const expiryText = settings && now > 0 && expiresAt ? formatRemaining(expiresAt - (now + clockOffset)) : null;

  const activeFile = files?.find(f => f.filename === activeName) || null;
  const activeKind = activeFile ? getFileKind(activeFile.filename, activeFile.mimeType) : null;
  const activeOutline = activeName ? outlines[activeName] || [] : [];
  const sidePanelTab: TSidePanelTab =
    sideTab === 'settings' && isOwner ? 'settings' : activeFile ? (sideTab === 'settings' ? 'details' : sideTab) : 'chat';
  const unreadMessages = sidePanelTab === 'chat' ? 0 : Math.max(0, othersMessageCount - seenMessages);

  const switchSidePanel = (tab: TSidePanelTab) => {
    if (sidePanelTab === 'chat' || tab === 'chat') setSeenMessages(othersMessageCount);
    setSideTab(tab);
  };

  const openChatDrawer = () => {
    switchSidePanel('chat');
    setNavOpen(false);
    setInspectorOpen(true);
  };

  const unreadBadge =
    unreadMessages > 0 ? (
      <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold leading-5 text-white">
        {unreadMessages > 99 ? '99+' : unreadMessages}
      </span>
    ) : null;
  const showHtmlTools = isRenderedDocument(activeKind) && loads[activeName || '']?.status === 'ready';
  const canFind = showHtmlTools && viewMode !== 'source';

  // Info: (20261105 - Luphia) Ctrl/Cmd + F 聚焦頁內搜尋
  useEffect(() => {
    if (!canFind) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        findInputRef.current?.focus();
        findInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canFind]);

  // --- Info: (20261105 - Luphia) 版面區塊 ---

  const navigation = (
    <>
      <div className="flex items-center justify-between gap-2 px-1.5">
        <Link href="/" className="text-[17px] font-bold text-blue-400 hover:text-blue-300">
          Drop Here
        </Link>
        <span className="font-mono text-xs tracking-[0.06em] text-slate-300">#{roomId}</span>
      </div>
      {settings && now > 0 && (
        <p
          className={`-mt-2 flex items-center gap-1.5 px-1.5 text-xs ${expiresAt && expiresAt - (now + clockOffset) < 3600000 ? 'text-amber-300' : 'text-slate-400'}`}
        >
          <ClockIcon className="h-3.5 w-3.5" />
          {expiresAt ? formatRemaining(expiresAt - (now + clockOffset)) : 'No expiry set'}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          setActiveName(null);
          setActiveHeading('');
          setCallOpen(false);
          setNavOpen(false);
        }}
        aria-current={!activeName && !callOpen ? 'page' : undefined}
        className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${!activeName && !callOpen ? 'bg-slate-800 font-semibold text-white' : 'text-slate-300 hover:bg-white/5'}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12h4l3 8 4-16 3 8h4" />
        </svg>
        <span className="flex-1">Room activity</span>
        {chat.uploads.length > 0 && (
          <span className="rounded-full bg-blue-600 px-[7px] text-[10px] font-bold leading-[18px] text-white" aria-label={`${chat.uploads.length} uploads in progress`}>
            {chat.uploads.length}
          </span>
        )}
      </button>

      {call.enabled && (
        <button
          type="button"
          onClick={() => {
            setCallOpen(true);
            setNavOpen(false);
          }}
          aria-current={callOpen ? 'page' : undefined}
          className={`-mt-3.5 flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${callOpen ? 'bg-slate-800 font-semibold text-white' : 'text-slate-300 hover:bg-white/5'}`}
        >
          <VideoIcon className="h-4 w-4" />
          <span className="flex-1">{inCall ? 'In call' : 'Video call'}</span>
          {call.participants > 0 && (
            <span className="rounded-full bg-emerald-600 px-[7px] text-[10px] font-bold leading-[18px] text-white" aria-label={`${call.participants} people in the call`}>
              {call.participants}
            </span>
          )}
        </button>
      )}

      {(rootListing.folders.length > 0 || pendingFolders.length > 0) && (
        <div className="flex flex-col gap-0.5">
          <p className="mx-1.5 mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">Folders</p>
          {rootListing.folders.map(folder => {
            const isActive = !activeName && !callOpen && !!browse && (browse.path === folder.path || browse.path.startsWith(`${folder.path}/`));
            const uploading = chat.uploads.find(u => u.kind === 'folder' && u.filename === folder.name);
            return (
              <button
                key={folder.path}
                type="button"
                onClick={() => {
                  setActiveName(null);
                  setActiveHeading('');
                  setCallOpen(false);
                  setBrowse({ path: folder.path, selected: null });
                  setNavOpen(false);
                }}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${isActive ? 'bg-slate-800 font-semibold text-white' : 'text-slate-300 hover:bg-white/5'}`}
              >
                <FolderIcon className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                <span className={`shrink-0 font-mono text-[10px] ${uploading ? 'text-blue-300' : 'text-slate-500'}`}>
                  {uploading ? `${percentOf(uploading)}%` : folder.count}
                </span>
              </button>
            );
          })}
          {pendingFolders.map(u => (
            <span key={u.uploadId} className="flex min-h-9 items-center gap-2.5 px-2.5 text-[13px] italic text-slate-400">
              <FolderIcon className="h-4 w-4 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{u.filename}</span>
              <span className="shrink-0 font-mono text-[10px] not-italic text-blue-300">
                {u.status === 'interrupted' || uploader.paused.has(u.uploadId) ? (u.paused || uploader.paused.has(u.uploadId) ? 'paused' : 'interrupted') : `${percentOf(u)}%`}
              </span>
            </span>
          ))}
        </div>
      )}

      {GROUP_ORDER.filter(group => groups[group].length > 0 || uploadGroups[group].length > 0).map(group => (
        <div key={group} className="flex flex-col gap-0.5">
          <p className="mx-1.5 mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">{FILE_GROUP_LABELS[group]}</p>
          {groups[group].map(f => {
            const kind = getFileKind(f.filename, f.mimeType);
            const isActive = f.filename === activeName;
            return (
              <button
                key={f.filename}
                type="button"
                onClick={() => openFile(f.filename)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${isActive ? 'bg-slate-800 font-semibold text-white' : 'text-slate-300 hover:bg-white/5'}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-sm ${FILE_KIND_DOT[kind]}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{f.filename}</span>
                  {myUploaderId && f.uploaderId === myUploaderId && <span className="block text-[10px] font-normal text-blue-300">You</span>}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-slate-500">{formatBytes(f.originalFileSize)}</span>
              </button>
            );
          })}
          {uploadGroups[group].map(u => (
            <span
              key={u.uploadId}
              className="flex min-h-9 items-center gap-2.5 px-2.5 text-[13px] italic text-slate-400"
              title={u.status === 'interrupted' ? 'Upload interrupted' : 'Uploading'}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-sm border border-dashed ${u.status === 'uploading' && !uploader.paused.has(u.uploadId) ? 'border-blue-300 motion-safe:animate-spin' : 'border-slate-400'}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{u.filename}</span>
              <span className={`shrink-0 font-mono text-[10px] not-italic ${u.status === 'interrupted' ? 'text-amber-300' : 'text-blue-300'}`}>
                {u.status === 'interrupted' || uploader.paused.has(u.uploadId) ? (u.paused || uploader.paused.has(u.uploadId) ? 'paused' : 'interrupted') : `${percentOf(u)}%`}
              </span>
            </span>
          ))}
        </div>
      ))}

      {files && files.length === 0 && pendingUploads.length === 0 && <p className="px-1.5 text-sm text-slate-400">No files in this room yet.</p>}

      {isRenderedDocument(activeKind) && activeOutline.length > 0 && viewMode !== 'source' && (
        <div className="flex flex-col gap-0.5 border-t border-white/10 pt-4">
          <p className="mx-1.5 mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-400 uppercase">On this page</p>
          {activeOutline.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                viewerRef.current?.scrollTo(item.id);
                setActiveHeading(item.id);
                setNavOpen(false);
              }}
              className={`min-h-8 rounded-md pr-2.5 text-left text-[13px] leading-5 py-1.5 transition-colors ${item.level >= 3 ? 'pl-6' : 'pl-2.5'} ${activeHeading === item.id ? 'bg-blue-500/10 text-blue-300' : 'text-slate-300 hover:bg-white/5'}`}
            >
              {item.text}
            </button>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
      <AccountButton compact />
      <button
        type="button"
        onClick={openChatDrawer}
        className="hidden h-10 items-center justify-center rounded-lg border border-white/10 text-xs font-semibold text-slate-300 hover:bg-white/5 lg:flex xl:hidden"
      >
        Chat · {chat.online} online
        {unreadBadge}
      </button>
      <button
        type="button"
        onClick={onExit}
        className="h-10 rounded-lg border border-white/10 text-xs font-semibold tracking-wide text-slate-300 uppercase hover:bg-white/5"
      >
        Exit room
      </button>
      </div>
    </>
  );

  const callAction = call.enabled ? (
    <button
      type="button"
      onClick={() => setCallOpen(true)}
      className="inline-flex h-10 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-[13px] font-semibold text-white hover:bg-emerald-500"
    >
      <VideoIcon className="h-4 w-4" />
      {inCall ? 'Open call' : call.participants > 0 ? `Join call · ${call.participants}` : 'Start call'}
    </button>
  ) : null;

  const renderMain = () => {
    if (callOpen && call.enabled && !errorMessage && files) {
      if (call.room) {
        return (
          <CallStage
            isOwner={isOwner}
            maxParticipants={call.maxParticipants}
            notice={call.notice}
            onDismissNotice={call.clearNotice}
            onLeave={() => {
              call.leave();
              setCallOpen(false);
            }}
            onModerate={(identity, action) => {
              call.moderate(identity, action);
            }}
            onMinimize={() => setCallOpen(false)}
          />
        );
      }
      return (
        <CallJoinPanel
          participants={call.participants}
          maxParticipants={call.maxParticipants}
          joining={call.state === 'joining'}
          error={call.error}
          notice={call.notice}
          onJoin={options => call.join(options)}
          onCancel={() => setCallOpen(false)}
        />
      );
    }
    if (isLoading && !files) {
      return <div className="flex flex-1 items-center justify-center font-mono text-sm text-slate-400 animate-pulse">Scanning blocks…</div>;
    }
    if (errorMessage) {
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-300 font-mono">{errorMessage}</div>
        </div>
      );
    }
    if (!activeFile) {
      return (
        <RoomActivity
          roomId={roomId}
          roomName={settings?.name || `Room ${roomId}`}
          uploadPolicy={settings?.uploadPolicy ?? 'everyone'}
          isOwner={isOwner}
          canUpload={settings?.canUpload ?? false}
          myUploaderId={myUploaderId}
          onUpload={() => fileInputRef.current?.click()}
          getActions={getFileActions}
          canDelete={canManageFile}
          callAction={callAction}
          browse={browse}
          onBrowse={(path, selected = null) => setBrowse(path ? { path, selected } : null)}
          onUploadFolder={() => folderInputRef.current?.click()}
          onDownloadFolder={handleDownloadFolder}
          onDownloadFile={handleDownload}
          folderActions={getFolderActions}
          canDownloadFile={isDownloadAllowed}
          onDelete={file => handleDelete(file.filename)}
          files={files || []}
          uploads={chat.uploads}
          online={chat.online}
          myMemberId={chat.me?.memberId ?? null}
          cancellable={uploader.active}
          cancelling={uploader.cancelling}
          pausedUploads={uploader.paused}
          onCancelUpload={requestCancel}
          onResumeUpload={uploader.resume}
          unfinished={settings?.canUpload ? uploader.unfinished : []}
          onResumeUnfinished={(uploadId, file) => {
            if (!uploader.resumeUnfinished(uploadId, file)) {
              pushToast({ message: `“${file.name}” is not the same file (name, size or date differ). Choose the original file, or discard the unfinished upload.`, tone: 'error' }, 6000);
            }
          }}
          onDiscardUnfinished={uploader.discardUnfinished}
          expiryText={expiryText}
          newFiles={newFiles}
          thumbnails={thumbnails}
          watching={watching}
          now={now}
          onToggleWatch={toggleWatch}
          onOpenFile={openFile}
        />
      );
    }

    return (
      <>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-white/10 px-4 py-2.5">
          <div className="flex h-9 min-w-0 flex-[1_1_280px] items-center gap-2 overflow-hidden rounded-lg border border-white/10 bg-slate-900 px-3 font-mono text-xs text-slate-400 whitespace-nowrap">
            <LockIcon className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <span className="truncate">
              drophere / {roomId} / <span className="text-slate-100">{activeFile.filename}</span>
            </span>
          </div>

          {canFind && (
            <form
              className="flex h-9 flex-[0_1_240px] items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900 pl-2.5 pr-1"
              onSubmit={e => {
                e.preventDefault();
                runFind(false);
              }}
            >
              <label htmlFor="find-in-page" className="sr-only">
                Find in page
              </label>
              <input
                id="find-in-page"
                aria-label="Find in page"
                ref={findInputRef}
                type="search"
                value={findQuery}
                placeholder="Find in page"
                onChange={e => {
                  setFindQuery(e.target.value);
                  setFindStatus('idle');
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault();
                    runFind(true);
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-500 pointer-coarse:text-base"
              />
              {findStatus === 'missing' && <span className="shrink-0 text-[11px] text-amber-300">No match</span>}
              {findStatus === 'found' && (
                <span className="shrink-0 font-mono text-[11px] text-slate-400" aria-live="polite">
                  {findPosition.index}/{findPosition.total}
                </span>
              )}
              <button type="submit" className="h-7 shrink-0 rounded-md px-2 text-[11px] font-semibold text-slate-300 hover:bg-white/10">
                Next
              </button>
            </form>
          )}

          {showHtmlTools && (
            <div role="group" aria-label="View mode" className="inline-flex gap-[3px] rounded-[10px] border border-white/10 bg-slate-900 p-[3px]">
              {(
                [
                  ['reading', 'Reading'],
                  ['full', 'Full width'],
                  ['source', 'Source'],
                ] as [TViewMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={viewMode === mode}
                  onClick={() => setViewMode(mode)}
                  className={`h-[30px] rounded-[7px] px-2.5 text-xs ${viewMode === mode ? 'bg-slate-800 font-semibold text-white' : 'font-medium text-slate-400 hover:text-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              switchSidePanel('details');
              setInspectorOpen(true);
            }}
            className="h-9 rounded-lg border border-white/10 px-3 text-xs font-medium text-slate-300 hover:bg-white/5 xl:hidden"
          >
            Details
          </button>
          <button
            type="button"
            onClick={openChatDrawer}
            className="inline-flex h-9 items-center rounded-lg border border-white/10 px-3 text-xs font-medium text-slate-300 hover:bg-white/5 xl:hidden"
          >
            Chat
            {unreadBadge}
          </button>
        </div>

        <div className="relative min-h-0 flex-1 bg-slate-950">
          <FilePreviewPane
            key={activeFile.filename}
            file={activeFile}
            load={loads[activeFile.filename]}
            viewMode={viewMode}
            previewOptions={previewOptions}
            resolver={resolver}
            viewerRef={viewerRef}
            onLoad={() => {
              loadBlob(activeFile.filename).catch(() => undefined);
            }}
            canDownload={isDownloadAllowed(activeFile)}
            onDownload={() => handleDownload(activeFile.filename)}
            onOutline={handleOutline}
            onActiveHeading={setActiveHeading}
            onOpenFile={openFile}
            onFindResult={handleFindResult}
            onPrepared={handlePrepared}
          />
        </div>
      </>
    );
  };

  return (
    <RoomContext.Provider value={call.room ?? undefined}>
    {call.room && <RoomAudioRenderer />}
    <div className="fixed inset-x-0 top-viewport flex h-viewport flex-col overflow-hidden bg-slate-950 font-sans text-slate-100 lg:flex-row">
      {/* Info: (20261105 - Luphia) 手機版頂部列 */}
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          className="h-10 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-200"
        >
          Files
        </button>
        <span className="flex-1 truncate font-mono text-xs text-slate-300">#{roomId}</span>
        {call.enabled && (
          <button
            type="button"
            onClick={() => setCallOpen(true)}
            aria-label={inCall ? 'Open call' : 'Video call'}
            className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${inCall ? 'bg-emerald-600 text-white' : 'border border-white/10 text-slate-200'}`}
          >
            <VideoIcon className="h-4 w-4" />
            {call.participants > 0 && <span>{call.participants}</span>}
          </button>
        )}
        <button
          type="button"
          onClick={openChatDrawer}
          className="inline-flex h-10 items-center rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-200"
        >
          Chat
          {unreadBadge}
        </button>
      </div>

      <nav
        aria-label="Room files"
        className={`${navOpen ? 'fixed inset-x-0 top-viewport z-40 flex h-viewport' : 'hidden'} w-full flex-col gap-[18px] overflow-y-auto border-r border-white/10 bg-[#0D1424] px-3.5 py-[18px] lg:static lg:flex lg:w-[264px] lg:shrink-0`}
      >
        {navOpen && (
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Close file list"
            className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-lg text-slate-300 lg:hidden"
          >
            <XIcon className="text-slate-300" />
          </button>
        )}
        {navigation}
      </nav>

      <main
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        onDragOver={e => {
          if (!settings?.canUpload || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={e => {
          if (!settings?.canUpload) return;
          e.preventDefault();
          setDragActive(false);
          // Info: (20261108 - Luphia) 拖曳的項目必須在事件當下讀取 (之後 dataTransfer 會被清空)
          collectDropped(e.dataTransfer)
            .then(prepareUpload)
            .catch(() => pushToast({ message: 'Could not read the dropped items.', tone: 'error' }));
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload files"
          onChange={e => {
            handlePickedFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={el => {
            folderInputRef.current = el;
            // Info: (20261108 - Luphia) 選擇整個資料夾 (React 不支援 webkitdirectory 屬性的型別)
            el?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload a folder"
          onChange={e => {
            handlePickedFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {dragActive && (
          <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-950/70 text-sm font-semibold text-blue-100">
            Drop files or folders to upload to this room
          </div>
        )}
        {openTabs.length > 0 && (
          <div role="tablist" aria-label="Open files" className="flex items-end gap-0.5 overflow-x-auto border-b border-white/10 bg-[#0D1424] px-3 pt-2.5">
            {openTabs.map((name, index) => {
              const meta = files?.find(f => f.filename === name);
              const kind = meta ? getFileKind(meta.filename, meta.mimeType) : 'other';
              const selected = name === activeName;
              return (
                <div
                  key={name}
                  className={`-mb-px flex h-10 shrink-0 items-center gap-1 rounded-t-[10px] border pl-3.5 pr-1.5 ${selected ? 'border-white/10 border-b-slate-950 bg-slate-950' : 'border-transparent'}`}
                >
                  <button
                    id={`tab-${index}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => {
                      setActiveName(name);
                      setActiveHeading('');
                      setFindStatus('idle');
                      setCallOpen(false);
                    }}
                    onKeyDown={e => handleTabKeyDown(e, index)}
                    className={`flex items-center gap-2 whitespace-nowrap text-[13px] ${selected ? 'font-semibold text-white' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    <span className={`h-2 w-2 rounded-sm ${FILE_KIND_DOT[kind]}`} aria-hidden="true" />
                    <span title={name}>{baseName(name)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${name}`}
                    onClick={() => closeTab(name)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-slate-200"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {renderMain()}
        {inCall && !callOpen && (
          <CallMiniBar
            onOpen={() => setCallOpen(true)}
            onLeave={() => call.leave()}
          />
        )}
        {!inCall && !callOpen && call.notice && (
          <div className="flex items-center gap-2 border-t border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200" role="status">
            <span className="flex-1">{call.notice}</span>
            <button type="button" onClick={call.clearNotice} className="font-semibold hover:text-amber-100">
              Dismiss
            </button>
          </div>
        )}
      </main>

      <aside
        aria-label="Side panel"
        className={`${inspectorOpen ? 'fixed right-0 top-viewport z-40 flex h-viewport w-full shadow-2xl shadow-black sm:w-[340px]' : 'hidden'} min-h-0 flex-col overflow-hidden border-l border-white/10 bg-[#0D1424] xl:static xl:flex xl:w-[320px] xl:shrink-0 xl:shadow-none`}
      >
        <div className="flex items-center gap-1 border-b border-white/10 px-3 pt-3">
          <div role="tablist" aria-label="Side panel" className="flex flex-1 gap-1">
            {activeFile && (
              <button
                type="button"
                role="tab"
                aria-selected={sidePanelTab === 'details'}
                onClick={() => switchSidePanel('details')}
                className={`-mb-px h-10 border-b-2 px-3 text-xs font-semibold ${sidePanelTab === 'details' ? 'border-blue-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
              >
                Details
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={sidePanelTab === 'chat'}
              onClick={() => switchSidePanel('chat')}
              className={`-mb-px inline-flex h-10 items-center border-b-2 px-3 text-xs font-semibold ${sidePanelTab === 'chat' ? 'border-blue-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              Chat
              <span className="ml-1.5 font-normal text-slate-400">{chat.status === 'connected' ? chat.online : ''}</span>
              {unreadBadge}
            </button>
            {isOwner && (
              <button
                type="button"
                role="tab"
                aria-selected={sidePanelTab === 'settings'}
                onClick={() => switchSidePanel('settings')}
                className={`-mb-px h-10 border-b-2 px-3 text-xs font-semibold ${sidePanelTab === 'settings' ? 'border-blue-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
              >
                Settings
              </button>
            )}
          </div>
          {inspectorOpen && (
            <button
              type="button"
              onClick={() => setInspectorOpen(false)}
              aria-label="Close side panel"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-300 hover:bg-white/5 xl:hidden"
            >
              <XIcon className="text-slate-300" />
            </button>
          )}
        </div>

        {sidePanelTab === 'details' && activeFile ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <FileInspector
              file={activeFile}
              shardStats={shardStats[activeFile.filename]}
              downloadProgress={downloading[activeFile.filename] ? loads[activeFile.filename]?.progress ?? 0 : null}
              linkCopied={linkCopied}
              previewOptions={previewOptions}
              inlinedFiles={inlinedFiles[activeFile.filename] || []}
              onPreviewOptionsChange={setPreviewOptions}
              repair={repairs[activeFile.filename]}
              onRepair={() => handleRepair(activeFile.filename)}
              onDownload={() => handleDownload(activeFile.filename)}
              onCopyLink={() => handleCopyLink(activeFile.filename)}
              onPrint={() => viewerRef.current?.print()}
              uploaderLabel={uploaderLabel(activeFile)}
              canManage={canManageFile(activeFile)}
              onToggleDownload={allow => handleToggleDownload(activeFile.filename, allow)}
              onDelete={() => handleDelete(activeFile.filename)}
            />
          </div>
        ) : sidePanelTab === 'settings' && settings ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RoomSettingsPanel key={settings.name} settings={settings} saving={settingsSaving} error={settingsError} onChange={handleSettingsChange} />
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <RoomChat chat={chat} showHeader={false} />
          </div>
        )}
      </aside>

      {(toasts.length > 0 || zipJob) && (
        <div className="fixed bottom-4 left-4 z-50 flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
          {zipJob && (
            <div className="flex flex-col gap-2 rounded-[14px] border border-white/15 bg-slate-800 px-3.5 py-3 shadow-2xl shadow-black/50">
              <div className="flex justify-between gap-3 text-[13px] text-slate-100">
                <span className="min-w-0 truncate">Preparing {zipJob.name}</span>
                <span className="shrink-0 font-mono text-blue-300">
                  {zipJob.done} / {zipJob.total}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${zipJob.total ? (zipJob.done / zipJob.total) * 100 : 0}%` }} />
              </div>
              <p className="text-[11px] text-slate-400">Files are downloaded and zipped in your browser.</p>
            </div>
          )}
          {toasts.map(toast => {
            const tone =
              toast.tone === 'success'
                ? { box: 'border-emerald-800 bg-emerald-950', text: 'text-emerald-50', button: 'bg-emerald-600 hover:bg-emerald-500', close: 'text-emerald-200' }
                : toast.tone === 'error'
                  ? { box: 'border-red-800 bg-red-950', text: 'text-red-50', button: 'bg-red-600 hover:bg-red-500', close: 'text-red-200' }
                  : { box: 'border-white/15 bg-slate-800', text: 'text-slate-100', button: 'bg-blue-600 hover:bg-blue-500', close: 'text-slate-300' };
            return (
              <div key={toast.id} className={`flex items-center gap-3 rounded-[14px] border px-3.5 py-3 shadow-2xl shadow-black/50 ${tone.box}`}>
                {toast.tone === 'success' && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34D399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="m8 12 3 3 5-6" />
                  </svg>
                )}
                <span className={`min-w-0 flex-1 truncate text-[13px] ${tone.text}`}>{toast.message}</span>
                {toast.actionLabel && toast.onAction && (
                  <button
                    type="button"
                    onClick={() => {
                      toast.onAction?.();
                      dismissToast(toast.id);
                    }}
                    className={`h-8 shrink-0 rounded-lg px-3 text-xs font-semibold text-white ${tone.button}`}
                  >
                    {toast.actionLabel}
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismissToast(toast.id)}
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 ${tone.close}`}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {cancelAsk && (
        <div className="fixed inset-x-0 top-viewport z-50 flex h-viewport items-center justify-center bg-black/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-upload-title"
            className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
          >
            <h2 id="cancel-upload-title" className="text-lg font-bold text-slate-100">
              Cancel uploading “{cancelAsk.name}”?
            </h2>
            <p className="text-sm leading-6 text-slate-300">
              {cancelAsk.done} of {cancelAsk.total} files are already in the room. Remove them too, or keep them as an incomplete folder?
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setCancelAsk(null)}
                className="h-10 whitespace-nowrap rounded-xl border border-white/10 px-4 text-[13px] font-semibold text-slate-300 hover:bg-white/5"
              >
                Keep uploading
              </button>
              <button
                type="button"
                onClick={() => {
                  uploader.cancel(cancelAsk.uploadId, { keepFiles: true });
                  setCancelAsk(null);
                }}
                className="h-10 whitespace-nowrap rounded-xl border border-white/10 px-4 text-[13px] font-semibold text-slate-100 hover:bg-white/5"
              >
                Cancel, keep {cancelAsk.done} {cancelAsk.done === 1 ? 'file' : 'files'}
              </button>
              <button
                type="button"
                onClick={() => {
                  uploader.cancel(cancelAsk.uploadId);
                  setCancelAsk(null);
                }}
                className="h-10 whitespace-nowrap rounded-xl bg-red-600 px-4 text-[13px] font-semibold text-white hover:bg-red-500"
              >
                Cancel and remove
              </button>
            </div>
          </section>
        </div>
      )}

      {pendingDrop && (
        <div className="fixed inset-x-0 top-viewport z-50 flex h-viewport items-center justify-center bg-black/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-upload-title"
            className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
          >
            <h2 id="folder-upload-title" className="text-lg font-bold text-slate-100">
              {pendingDrop.folders.length === 1 ? `Upload folder “${pendingDrop.folders[0].name}”?` : `Upload ${pendingDrop.folders.length} folders?`}
            </h2>
            <ul className="flex flex-col gap-2">
              {pendingDrop.folders.map(folder => (
                <li key={folder.name} className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0B1222] px-3 py-2.5">
                  <FolderIcon className="h-7 w-7" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-100">{folder.name}</span>
                    <span className="text-xs text-slate-400">
                      {folder.count} {folder.count === 1 ? 'file' : 'files'} · {formatBytes(folder.size)}
                      {folder.name !== folder.original ? ` · renamed from “${folder.original}”` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-5 text-slate-400">
              Folder structure is kept.
              {pendingDrop.looseCount > 0 ? ` ${pendingDrop.looseCount} loose ${pendingDrop.looseCount === 1 ? 'file is' : 'files are'} uploaded too.` : ''}
              {pendingDrop.skipped > 0 ? ` Skipped ${pendingDrop.skipped} system ${pendingDrop.skipped === 1 ? 'item' : 'items'} (like .DS_Store).` : ''}
              {pendingDrop.folders.some(f => f.name !== f.original) ? ' A folder with the same name already exists, so the new one gets a number.' : ''}
            </p>
            {pendingDrop.truncated && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Only the first {pendingDrop.entries.length} files will be uploaded. Split very large folders into several uploads.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setPendingDrop(null)} className="h-10 rounded-xl border border-white/10 px-4 text-[13px] font-semibold text-slate-300 hover:bg-white/5">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  uploadFiles(pendingDrop.entries);
                  setPendingDrop(null);
                }}
                className="h-10 rounded-xl bg-blue-600 px-4 text-[13px] font-semibold text-white hover:bg-blue-500"
              >
                Upload {pendingDrop.entries.length} {pendingDrop.entries.length === 1 ? 'file' : 'files'}
              </button>
            </div>
          </section>
        </div>
      )}

      {needsPassword && (
        <div className="fixed inset-x-0 top-viewport z-50 h-viewport flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <form
            onSubmit={handlePasswordSubmit}
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl"
            aria-labelledby="password-title"
          >
            <h2 id="password-title" className="mb-1 text-lg font-bold text-slate-100">
              Password required
            </h2>
            <p className="mb-4 text-sm text-slate-400">Room #{roomId} is protected.</p>
            <label htmlFor="room-password" className="sr-only">
              Room password
            </label>
            <input
              id="room-password"
              aria-label="Room password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mb-3 h-12 w-full rounded-xl border border-white/10 bg-black/40 px-4 text-center font-mono text-lg tracking-widest text-white outline-none focus:ring-2 focus:ring-blue-500/50"
            />
            {passwordError && <p className="mb-3 text-center text-xs font-bold text-red-400">{passwordError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onExit}
                className="h-11 flex-1 rounded-xl border border-white/10 font-bold text-slate-400 hover:bg-white/5"
              >
                Cancel
              </button>
              <button type="submit" className="h-11 flex-1 rounded-xl bg-blue-600 font-bold text-white hover:bg-blue-500">
                Unlock
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
    </RoomContext.Provider>
  );
}
