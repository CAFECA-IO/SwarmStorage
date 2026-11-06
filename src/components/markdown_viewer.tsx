import { useEffect, useState, type ComponentProps } from 'react';
import HtmlViewer from '@/components/html_viewer';

type THtmlViewerProps = ComponentProps<typeof HtmlViewer>;

interface IMarkdownViewerProps extends Omit<THtmlViewerProps, 'html' | 'appearance'> {
  markdown: string;
}

interface IRendered {
  source: string;
  html: string;
}

/**
 * Info: (20261106 - Luphia)
 * Markdown 文件預覽：動態載入轉換器 (含 mermaid)，轉成 HTML 後交給 sandbox 的 HtmlViewer 呈現
 * 因此目錄、頁內搜尋、列印、房間檔案連結與安全開關都與 HTML 文件一致
 */
export default function MarkdownViewer({ markdown, ...viewerProps }: IMarkdownViewerProps) {
  const [rendered, setRendered] = useState<IRendered | null>(null);
  const [error, setError] = useState<{ source: string; message: string } | null>(null);
  const { filename } = viewerProps;

  useEffect(() => {
    let cancelled = false;
    import('@/lib/markdown_render')
      .then(module => module.renderMarkdown(markdown, filename))
      .then(result => {
        if (!cancelled) setRendered({ source: markdown, html: result.html });
      })
      .catch(err => {
        if (!cancelled) setError({ source: markdown, message: err instanceof Error ? err.message : 'Failed to render Markdown' });
      });
    return () => {
      cancelled = true;
    };
  }, [markdown, filename]);

  if (error && error.source === markdown) {
    return <div className="m-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error.message}</div>;
  }

  if (!rendered || rendered.source !== markdown) {
    return <div className="flex h-full items-center justify-center font-mono text-sm text-slate-400 animate-pulse">Rendering Markdown…</div>;
  }

  return <HtmlViewer {...viewerProps} appearance="app" html={rendered.html} />;
}
