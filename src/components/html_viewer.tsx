import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  PREVIEW_MESSAGE_SOURCE,
  PREVIEW_SANDBOX,
  isPreviewMessage,
  prepareHtmlPreview,
  type IHtmlOutlineItem,
  type IHtmlPreviewOptions,
  type IPreparedHtml,
  type IRoomFileResolver,
  type TPreviewCommand,
} from '@/lib/html_preview';

export interface IHtmlViewerHandle {
  scrollTo: (id: string) => void;
  find: (query: string, backwards?: boolean) => void;
  print: () => void;
}

interface IHtmlViewerProps {
  ref?: Ref<IHtmlViewerHandle>;
  filename: string;
  html: string;
  options: IHtmlPreviewOptions;
  resolver: IRoomFileResolver;
  fullWidth: boolean;
  onOutline: (outline: IHtmlOutlineItem[]) => void;
  onActiveHeading: (id: string) => void;
  onOpenFile: (filename: string) => void;
  onFindResult: (result: { found: boolean; index: number; total: number }) => void;
  onPrepared?: (prepared: IPreparedHtml) => void;
}

/**
 * Info: (20261105 - Luphia)
 * 在 sandbox iframe 中呈現 HTML 文件；與文件的溝通只透過 postMessage
 */
export default function HtmlViewer({
  ref,
  filename,
  html,
  options,
  resolver,
  fullWidth,
  onOutline,
  onActiveHeading,
  onOpenFile,
  onFindResult,
  onPrepared,
}: IHtmlViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [prepared, setPrepared] = useState<IPreparedHtml | null>(null);
  const [error, setError] = useState('');

  // Info: (20261105 - Luphia) 以 ref 保存回呼，避免每次 render 重新綁定訊息監聽
  const handlersRef = useRef({ onOutline, onActiveHeading, onOpenFile, onFindResult, onPrepared });
  useEffect(() => {
    handlersRef.current = { onOutline, onActiveHeading, onOpenFile, onFindResult, onPrepared };
  });

  const { allowScripts, allowExternal, resolveRoomFiles } = options;

  useEffect(() => {
    let cancelled = false;
    prepareHtmlPreview(html, { allowScripts, allowExternal, resolveRoomFiles }, resolver, filename)
      .then(result => {
        if (cancelled) return;
        setError('');
        setPrepared(result);
        handlersRef.current.onOutline(result.outline);
        handlersRef.current.onPrepared?.(result);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to prepare preview');
      });
    return () => {
      cancelled = true;
    };
  }, [html, filename, allowScripts, allowExternal, resolveRoomFiles, resolver]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Info: (20261105 - Luphia) 只接受來自本 iframe 的訊息 (sandbox 文件的 origin 為 "null")
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      if (!isPreviewMessage(event.data)) return;
      const message = event.data;
      const handlers = handlersRef.current;
      if (message.type === 'open' && typeof message.filename === 'string') handlers.onOpenFile(message.filename);
      else if (message.type === 'activeHeading' && typeof message.id === 'string') handlers.onActiveHeading(message.id);
      else if (message.type === 'findResult') {
        handlers.onFindResult({ found: Boolean(message.found), index: Number(message.index) || 0, total: Number(message.total) || 0 });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const send = (command: TPreviewCommand) => {
    iframeRef.current?.contentWindow?.postMessage({ ...command, source: PREVIEW_MESSAGE_SOURCE }, '*');
  };

  useImperativeHandle(ref, () => ({
    scrollTo: (id: string) => send({ type: 'scrollTo', id }),
    find: (query: string, backwards?: boolean) => send({ type: 'find', query, backwards }),
    print: () => send({ type: 'print' }),
  }));

  if (error) {
    return <div className="m-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</div>;
  }

  if (!prepared) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400 font-mono animate-pulse">Preparing preview…</div>;
  }

  return (
    <div className={`h-full w-full ${fullWidth ? '' : 'flex justify-center px-6 py-6'}`}>
      <iframe
        ref={iframeRef}
        title={`Preview of ${filename}`}
        srcDoc={prepared.srcDoc}
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        className={`bg-white ${fullWidth ? 'h-full w-full' : 'h-full w-full max-w-[880px] rounded-lg shadow-2xl shadow-black/40'}`}
      />
    </div>
  );
}
