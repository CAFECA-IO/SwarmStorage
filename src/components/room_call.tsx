import { useEffect, useRef, useState } from 'react';
import { Track, type Participant } from 'livekit-client';
import {
  VideoTrack,
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useLocalParticipant,
  usePagination,
  useParticipants,
  useTrackToggle,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import FileActionsMenu from '@/components/file_actions_menu';
import { MicIcon, MicOffIcon, PhoneOffIcon, ScreenShareIcon, VideoIcon, VideoOffIcon } from '@/components/icons';
import ToggleSwitch from '@/components/toggle_switch';

/**
 * Info: (20261106 - Luphia)
 * 房間視訊會議畫面 (最多 50 人)
 * - 分頁格狀排列：手機 4 格、平板 6 格、桌機 9 格、大螢幕 16 格；說話的人自動移到第一頁 (不打亂其他格子)
 * - 有人分享螢幕時，螢幕放大，其他人改為下方縮圖列
 * - 只有畫面上看得到的影像會被訂閱 (adaptiveStream)
 */

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase())
    .join('') || '?';

const AVATAR_TONES = ['bg-blue-900 text-blue-100', 'bg-emerald-900 text-emerald-100', 'bg-violet-900 text-violet-100', 'bg-amber-900 text-amber-100', 'bg-rose-900 text-rose-100', 'bg-teal-900 text-teal-100'];
const toneFor = (identity: string) => AVATAR_TONES[[...identity].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AVATAR_TONES.length];

const participantName = (p: Participant) => p.name || 'Guest';

// Info: (20261106 - Luphia) 依容器大小決定每頁格數
function usePageSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState(4);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(width < 640 ? 4 : width < 820 || height < 420 ? 6 : width >= 1400 && height >= 760 ? 16 : 9);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

const gridColumns = (count: number, wide: boolean) => {
  if (count <= 1 || (count === 2 && !wide)) return 'grid-cols-1';
  if (count <= 4) return 'grid-cols-2';
  if (count <= 6) return wide ? 'grid-cols-3' : 'grid-cols-2';
  if (count <= 9) return 'grid-cols-3';
  return 'grid-cols-4';
};

interface ITileProps {
  trackRef: TrackReferenceOrPlaceholder;
  isOwner: boolean;
  compact?: boolean;
  onModerate: (identity: string, action: 'mute' | 'remove') => void;
}

function ParticipantTile({ trackRef, isOwner, compact = false, onModerate }: ITileProps) {
  const participant = trackRef.participant;
  const speaking = useIsSpeaking(participant);
  const cameraMuted = useIsMuted(trackRef);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const name = participantName(participant);
  const isScreen = trackRef.source === Track.Source.ScreenShare;
  const showVideo = isTrackReference(trackRef) && !cameraMuted;

  return (
    <div
      className={`group relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-[#0B1222] ${compact ? 'aspect-video w-40 shrink-0' : 'h-full w-full'} ${speaking && !isScreen ? 'ring-2 ring-emerald-400' : 'ring-1 ring-white/10'}`}
      data-identity={participant.identity}
    >
      {showVideo ? (
        <VideoTrack
          trackRef={trackRef}
          className={`h-full w-full ${isScreen ? 'object-contain' : 'object-cover'} ${participant.isLocal && !isScreen ? '-scale-x-100' : ''}`}
        />
      ) : (
        <span
          className={`flex items-center justify-center rounded-full font-semibold ${toneFor(participant.identity)} ${compact ? 'h-10 w-10 text-sm' : 'h-16 w-16 text-xl sm:h-20 sm:w-20 sm:text-2xl'}`}
          aria-hidden="true"
        >
          {initials(name)}
        </span>
      )}
      <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
        {micMuted && !isScreen && <MicOffIcon className="h-3 w-3 shrink-0 text-red-300" />}
        <span className="truncate">
          {isScreen ? `${name}'s screen` : name}
          {participant.isLocal && !isScreen ? ' (You)' : ''}
        </span>
      </span>
      {isOwner && !participant.isLocal && !isScreen && (
        <div className="absolute right-1.5 top-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <FileActionsMenu
            filename={name}
            actions={[
              ...(micMuted ? [] : [{ label: 'Mute microphone', onSelect: () => onModerate(participant.identity, 'mute') }]),
              { label: 'Remove from call', onSelect: () => onModerate(participant.identity, 'remove'), danger: true },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function ControlButton({
  label,
  active,
  danger = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={danger ? undefined : active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-3.5 text-[13px] font-semibold transition-colors disabled:opacity-50 ${danger ? 'bg-red-600 text-white hover:bg-red-500' : active ? 'bg-slate-700 text-white hover:bg-slate-600' : 'bg-red-950 text-red-200 ring-1 ring-red-500/40 hover:bg-red-900'}`}
    >
      {children}
    </button>
  );
}

export function CallControls({ onLeave, compact = false }: { onLeave: () => void; compact?: boolean }) {
  const mic = useTrackToggle({ source: Track.Source.Microphone });
  const camera = useTrackToggle({ source: Track.Source.Camera });
  const screen = useTrackToggle({ source: Track.Source.ScreenShare });
  const [canShare] = useState(() => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia);

  return (
    <div className="flex items-center justify-center gap-2" role="group" aria-label="Call controls">
      <ControlButton label={mic.enabled ? 'Mute microphone' : 'Unmute microphone'} active={mic.enabled} disabled={mic.pending} onClick={() => mic.toggle()}>
        {mic.enabled ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
      </ControlButton>
      {!compact && (
        <ControlButton label={camera.enabled ? 'Turn off camera' : 'Turn on camera'} active={camera.enabled} disabled={camera.pending} onClick={() => camera.toggle()}>
          {camera.enabled ? <VideoIcon className="h-5 w-5" /> : <VideoOffIcon className="h-5 w-5" />}
        </ControlButton>
      )}
      {!compact && canShare && (
        <button
          type="button"
          aria-pressed={screen.enabled}
          disabled={screen.pending}
          onClick={() => screen.toggle()}
          className={`hidden h-12 items-center gap-2 rounded-full px-4 text-[13px] font-semibold sm:flex ${screen.enabled ? 'bg-blue-600 text-white hover:bg-blue-500' : 'bg-slate-700 text-white hover:bg-slate-600'}`}
        >
          <ScreenShareIcon className="h-5 w-5" />
          {screen.enabled ? 'Stop sharing' : 'Share screen'}
        </button>
      )}
      <ControlButton label="Leave call" active={false} danger onClick={onLeave}>
        <PhoneOffIcon className="h-5 w-5" />
        {!compact && <span className="hidden sm:inline">Leave</span>}
      </ControlButton>
    </div>
  );
}

interface ICallStageProps {
  isOwner: boolean;
  maxParticipants: number;
  notice: string;
  onDismissNotice: () => void;
  onLeave: () => void;
  onModerate: (identity: string, action: 'mute' | 'remove') => void;
  onMinimize: () => void;
}

export function CallStage({ isOwner, maxParticipants, notice, onDismissNotice, onLeave, onModerate, onMinimize }: ICallStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageSize = usePageSize(containerRef);
  const participants = useParticipants();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false }
  );
  const screens = tracks.filter(t => t.source === Track.Source.ScreenShare && isTrackReference(t));
  const cameras = tracks.filter(t => t.source === Track.Source.Camera);
  const sharing = screens.length > 0;
  const pagination = usePagination(sharing ? Math.min(pageSize, 6) : pageSize, cameras);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width > entry.contentRect.height * 1.2));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-slate-950" aria-label="Video call">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-slate-100">
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
          In call
        </span>
        <span className="text-xs text-slate-400">
          {participants.length} / {maxParticipants || 50} people
        </span>
        <span className="flex-1" />
        {pagination.totalPageCount > 1 && (
          <div className="flex items-center gap-1 text-xs text-slate-300" role="group" aria-label="Pages">
            <button type="button" onClick={pagination.prevPage} aria-label="Previous page" className="h-8 w-8 rounded-lg hover:bg-white/10">
              ‹
            </button>
            <span className="font-mono" aria-live="polite">
              {pagination.currentPage} / {pagination.totalPageCount}
            </span>
            <button type="button" onClick={pagination.nextPage} aria-label="Next page" className="h-8 w-8 rounded-lg hover:bg-white/10">
              ›
            </button>
          </div>
        )}
        <button type="button" onClick={onMinimize} className="h-8 rounded-lg border border-white/10 px-3 text-xs font-semibold text-slate-300 hover:bg-white/5">
          Back to files
        </button>
      </header>

      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-2 p-2 sm:p-3">
        {sharing ? (
          <>
            <div className="min-h-0 flex-1">
              <ParticipantTile trackRef={screens[0]} isOwner={isOwner} onModerate={onModerate} />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {pagination.tracks.map(t => (
                <ParticipantTile key={`${t.participant.identity}-${t.source}`} trackRef={t} isOwner={isOwner} compact onModerate={onModerate} />
              ))}
            </div>
          </>
        ) : (
          <div className={`grid min-h-0 flex-1 auto-rows-fr gap-2 ${gridColumns(pagination.tracks.length, wide)}`}>
            {pagination.tracks.map(t => (
              <ParticipantTile key={`${t.participant.identity}-${t.source}`} trackRef={t} isOwner={isOwner} onModerate={onModerate} />
            ))}
          </div>
        )}
      </div>

      {notice && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="status">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={onDismissNotice} className="font-semibold hover:text-amber-100">
            Dismiss
          </button>
        </div>
      )}
      <div className="border-t border-white/10 px-3 py-3">
        <CallControls onLeave={onLeave} />
      </div>
    </section>
  );
}

/**
 * Info: (20261106 - Luphia)
 * 檢視檔案時的通話小工具列：維持通話與聲音，可快速靜音、回到通話或離開
 */
export function CallMiniBar({ onOpen, onLeave }: { onOpen: () => void; onLeave: () => void }) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const speakingNames = participants.filter(p => p.isSpeaking && p.identity !== localParticipant.identity).map(participantName);

  return (
    <div className="flex items-center gap-3 border-t border-white/10 bg-[#0D1424] px-3 py-2" role="region" aria-label="Call">
      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block text-[13px] font-semibold text-slate-100">In call · {participants.length}</span>
        <span className="block truncate text-[11px] text-slate-400">{speakingNames.length ? `${speakingNames.join(', ')} speaking` : 'Tap to open the call'}</span>
      </button>
      <CallControls onLeave={onLeave} compact />
    </div>
  );
}

/**
 * Info: (20261106 - Luphia)
 * 加入通話前的設定：是否開啟麥克風、鏡頭；人多時預設靜音
 */
export function CallJoinPanel({
  participants,
  maxParticipants,
  joining,
  error,
  notice,
  onJoin,
  onCancel,
}: {
  participants: number;
  maxParticipants: number;
  joining: boolean;
  error: string;
  notice: string;
  onJoin: (options: { microphone: boolean; camera: boolean }) => void;
  onCancel: () => void;
}) {
  const [microphone, setMicrophone] = useState(participants < 5);
  const [camera, setCamera] = useState(false);
  const full = maxParticipants > 0 && participants >= maxParticipants;

  return (
    <div className="flex flex-1 items-center justify-center p-5">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-white/10 bg-[#0B1222] p-6">
        <div>
          <h2 className="text-lg font-bold text-slate-100">Join the call</h2>
          <p className="mt-1 text-[13px] text-slate-400">
            {participants > 0 ? `${participants} of ${maxParticipants} people are in the call.` : `Nobody is in the call yet. Up to ${maxParticipants} people can join.`}
          </p>
        </div>
        <div className="flex flex-col">
          <ToggleSwitch id="call-join-mic" label="Microphone" description={microphone ? 'On when you join' : 'Muted when you join'} checked={microphone} onChange={setMicrophone} />
          <ToggleSwitch id="call-join-camera" label="Camera" description={camera ? 'On when you join' : 'Off when you join'} checked={camera} onChange={setCamera} />
        </div>
        {(error || notice) && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300" role="alert">
            {error || notice}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="h-11 flex-1 rounded-xl border border-white/10 text-[13px] font-semibold text-slate-300 hover:bg-white/5">
            Cancel
          </button>
          <button
            type="button"
            disabled={joining || full}
            onClick={() => onJoin({ microphone, camera })}
            className="h-11 flex-[2] rounded-xl bg-emerald-600 text-[13px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {full ? 'Call is full' : joining ? 'Joining…' : 'Join now'}
          </button>
        </div>
        <p className="text-[11px] leading-4 text-slate-500">Audio and video go through the call server. Nothing is recorded.</p>
      </div>
    </div>
  );
}
