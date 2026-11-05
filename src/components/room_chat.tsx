import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { IRoomChat, TChatStatus } from '@/lib/use_room_chat';

const MAX_LENGTH = 1000;

const STATUS_TEXT: Record<TChatStatus, string> = {
  idle: 'Offline',
  connecting: 'Connecting…',
  connected: '',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Enter the room password to chat',
  expired: 'Room expired',
};

const formatTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

interface IRoomChatProps {
  chat: IRoomChat;
  // Info: (20261105 - Luphia) 訊息區高度 (Tailwind class)，預設填滿父層
  listClassName?: string;
  showHeader?: boolean;
}

/**
 * Info: (20261105 - Luphia)
 * 房間聊天面板：訊息列表、成員進出提示、輸入框 (Enter 送出，Shift+Enter 換行)
 */
export default function RoomChat({ chat, listClassName = 'flex-1 min-h-0', showHeader = true }: IRoomChatProps) {
  const { status, me, online, entries, sendError, send } = chat;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Info: (20261105 - Luphia) 使用者停留在底部時，新訊息自動捲到最下方
  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [entries.length]);

  const connected = status === 'connected';
  const trimmed = draft.trim();
  const tooLong = draft.length > MAX_LENGTH;

  const submit = async () => {
    if (!connected || !trimmed || tooLong || sending) return;
    setSending(true);
    const ok = await send(trimmed);
    setSending(false);
    if (ok) {
      setDraft('');
      stickToBottom.current = true;
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showHeader && (
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">Room chat</h2>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-500'}`} aria-hidden="true" />
            {connected ? `${online} online` : STATUS_TEXT[status]}
          </span>
        </div>
      )}

      <div
        ref={listRef}
        onScroll={e => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className={`${listClassName} overflow-y-auto px-4 py-3`}
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
      >
        {entries.length === 0 ? (
          <p className="mt-6 text-center text-xs leading-5 text-slate-400">
            Messages aren&apos;t saved.
            <br />
            Only people in this room right now can see them.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {entries.map(entry => {
              if (entry.kind === 'system') {
                return (
                  <li key={entry.id} className="text-center text-[11px] text-slate-400">
                    {entry.text}
                  </li>
                );
              }
              const { message } = entry;
              const mine = message.memberId === me?.memberId;
              return (
                <li key={entry.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                  <span className="mb-0.5 px-1 text-[11px] text-slate-400">
                    {mine ? 'You' : message.nickname} · {formatTime(message.sentAt)}
                  </span>
                  <p
                    className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] leading-5 ${mine ? 'rounded-br-md bg-blue-600 text-white' : 'rounded-bl-md bg-slate-800 text-slate-100'}`}
                  >
                    {message.text}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-white/10 p-3">
        {!connected && status !== 'connecting' && (
          <p className="mb-2 text-[11px] text-amber-300">{STATUS_TEXT[status]}</p>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor="room-chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="room-chat-input"
            aria-label="Message"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={Math.min(4, Math.max(1, draft.split('\n').length))}
            placeholder={connected ? (me ? `Message as ${me.nickname}` : 'Message') : 'Chat unavailable'}
            disabled={!connected}
            className="min-h-11 flex-1 resize-none rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-[13px] text-slate-100 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500/40 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!connected || !trimmed || tooLong || sending}
            className="h-11 shrink-0 rounded-xl bg-blue-600 px-4 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <div className="mt-1.5 flex justify-between gap-2 text-[11px]">
          <span className="text-red-400">{sendError}</span>
          {draft.length > MAX_LENGTH - 100 && (
            <span className={tooLong ? 'text-red-400' : 'text-slate-400'}>
              {draft.length}/{MAX_LENGTH}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
