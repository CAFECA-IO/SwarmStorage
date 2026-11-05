import { useState, useSyncExternalStore } from 'react';
import { QRCodeSVG } from 'qrcode.react';

interface IRoomSharePanelProps {
  roomNumber: string;
}

const noopSubscribe = () => () => undefined;
const getOrigin = () => window.location.origin;
const getServerOrigin = () => '';

/**
 * Info: (20261105 - Luphia)
 * 房間分享：顯示分享網址、複製按鈕與 QR code
 */
export default function RoomSharePanel({ roomNumber }: IRoomSharePanelProps) {
  // Info: (20261105 - Luphia) 以 useSyncExternalStore 取得 origin，避免 SSR 與瀏覽器渲染結果不一致
  const origin = useSyncExternalStore(noopSubscribe, getOrigin, getServerOrigin);
  const shareUrl = origin ? `${origin}/room/${roomNumber}` : `/room/${roomNumber}`;
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', shareUrl);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-center gap-2">
        <label htmlFor="room-share-url" className="sr-only">
          Room share link
        </label>
        <input
          id="room-share-url"
          aria-label="Room share link"
          readOnly
          value={shareUrl}
          onFocus={e => e.target.select()}
          className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-slate-300 outline-none focus:ring-2 focus:ring-blue-500/40"
        />
        <button
          type="button"
          onClick={handleCopy}
          className="h-10 shrink-0 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-500"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={() => setShowQr(v => !v)}
          aria-expanded={showQr}
          aria-controls="room-share-qr"
          aria-label={showQr ? 'Hide QR code' : 'Show QR code'}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors ${showQr ? 'border-blue-500/60 bg-blue-500/15 text-blue-300' : 'border-white/10 text-slate-300 hover:bg-white/5'}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h3v3" />
          </svg>
        </button>
      </div>

      {showQr && (
        <div id="room-share-qr" className="mt-3 flex flex-col items-center gap-2">
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={shareUrl} size={168} level="M" marginSize={0} title={`QR code for room ${roomNumber}`} />
          </div>
          <p className="text-center text-[11px] text-slate-400">Scan to open room #{roomNumber}. Share the password separately if you set one.</p>
        </div>
      )}
    </div>
  );
}
