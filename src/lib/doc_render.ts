import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkGemoji from 'remark-gemoji';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import type { Root as MdastRoot, RootContent } from 'mdast';
import 'katex/contrib/mhchem';
import { renderMermaid, type MermaidConfig } from '@/lib/mermaid_runner';
import { loadKatexCss } from '@/lib/markdown_render';
import { DOC_THEMES, MARGIN_SIZES, splitFrontMatter, type IDocSettings } from '@/lib/doc_settings';
import { PAGEBREAK } from '@/lib/doc_blocks';
export { splitBlocks, joinBlocks, type IDocBlock, type TDocBlockKind } from '@/lib/doc_blocks';

/**
 * Info: (20261118 - Luphia)
 * 文件編輯器的排版 (瀏覽器端)
 * - 文件切成區塊 (標題、段落、清單、表格、數學式、圖表…)，每個區塊可單獨編輯與重新排版
 * - 數學式以 KaTeX 排版 (含 \ce 化學式)、```mermaid 以 mermaid 轉為 SVG (淺色、依主題配色)
 * - 文件內的 HTML 經過 sanitize (不允許腳本、事件、樣式)，因此可以直接放進主頁面
 * - 圖片可引用房間內的檔案 (相對於文件所在資料夾)，排版時轉為 data: URI，PDF 也不需要再連線
 */

export interface IDocAssetResolver {
  // Info: (20261118 - Luphia) 依文件中的引用 (例如 figures/plot.png) 取得圖片的 data: URI；不是房間檔案時回傳 null
  image: (ref: string) => Promise<string | null>;
}

const MERMAID_PLACEHOLDER = (index: number) => `<!--dh-mermaid-${index}-->`;
const PAGEBREAK_PLACEHOLDER = '<!--dh-pagebreak-->';

// Info: (20261118 - Luphia) 允許的 HTML：GitHub 預設白名單，加上數學式的 class 與分頁註解；不允許 style / 事件 / 腳本
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  allowComments: true,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};

function remarkDocBlocks(diagrams: string[]) {
  return () => (tree: MdastRoot) => {
    const visit = (parent: { children: RootContent[] }) => {
      parent.children.forEach((node, index) => {
        if (node.type === 'code' && (node.lang || '').toLowerCase() === 'mermaid') {
          parent.children[index] = { type: 'html', value: MERMAID_PLACEHOLDER(diagrams.length) };
          diagrams.push(node.value);
          return;
        }
        if (node.type === 'html' && PAGEBREAK.test(node.value.trim())) {
          parent.children[index] = { type: 'html', value: PAGEBREAK_PLACEHOLDER };
          return;
        }
        if ('children' in node) visit(node as unknown as { children: RootContent[] });
      });
    };
    visit(tree);
  };
}

async function toHtml(markdown: string, diagrams: string[], withSlugs: boolean): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkGemoji)
    .use(remarkDocBlocks(diagrams))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, SCHEMA);
  if (withSlugs) processor.use(rehypeSlug);
  const file = await processor
    .use(rehypeKatex, { output: 'html', strict: 'ignore', trust: false })
    .use(rehypeHighlight, { detect: false, ignoreMissing: true } as Parameters<typeof rehypeHighlight>[0])
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const mermaidConfigFor = (settings: IDocSettings): MermaidConfig => {
  const theme = DOC_THEMES[settings.theme];
  return {
    theme: 'base',
    fontFamily: 'ui-sans-serif, system-ui, "Noto Sans TC", "PingFang TC", sans-serif',
    themeVariables: {
      darkMode: false,
      background: '#ffffff',
      fontSize: '14px',
      primaryColor: theme.soft,
      primaryBorderColor: theme.accent,
      primaryTextColor: theme.ink,
      secondaryColor: '#F1F5F9',
      secondaryBorderColor: '#94A3B8',
      tertiaryColor: '#F8FAFC',
      lineColor: '#64748B',
      textColor: '#1F2937',
      mainBkg: theme.soft,
      nodeBorder: theme.accent,
      clusterBkg: '#F8FAFC',
      clusterBorder: '#CBD5E1',
      edgeLabelBackground: '#FFFFFF',
      actorBkg: theme.soft,
      actorBorder: theme.accent,
      actorTextColor: theme.ink,
      signalColor: '#334155',
      signalTextColor: '#1F2937',
      noteBkgColor: '#FEF9C3',
      noteBorderColor: '#CA8A04',
      noteTextColor: '#422006',
    },
  };
};

// Info: (20261118 - Luphia) 同一張圖表在同一主題下只繪製一次 (編輯時其他區塊不必重畫)
const mermaidCache = new Map<string, Promise<{ ok: true; svg: string } | { ok: false; error: string }>>();
const MAX_MERMAID_CACHE = 80;

export function renderDiagram(code: string, settings: IDocSettings) {
  const key = `${settings.theme}\u0000${code}`;
  let cached = mermaidCache.get(key);
  if (!cached) {
    if (mermaidCache.size >= MAX_MERMAID_CACHE) mermaidCache.delete(mermaidCache.keys().next().value as string);
    cached = renderMermaid(code, mermaidConfigFor(settings));
    mermaidCache.set(key, cached);
  }
  return cached;
}

async function finishHtml(html: string, diagrams: string[], settings: IDocSettings, assets: IDocAssetResolver | null) {
  let result = html.split(PAGEBREAK_PLACEHOLDER).join('<div class="dh-pagebreak" role="separator" aria-label="Page break"></div>');
  for (let i = 0; i < diagrams.length; i++) {
    const rendered = await renderDiagram(diagrams[i], settings);
    const replacement = rendered.ok
      ? `<figure class="dh-mermaid">${rendered.svg}</figure>`
      : `<div class="dh-error"><strong>Mermaid diagram could not be drawn</strong><pre>${escapeHtml(rendered.error)}</pre></div>`;
    result = result.replace(MERMAID_PLACEHOLDER(i), () => replacement);
  }
  if (!assets || !/<img\s/i.test(result)) return result;

  // Info: (20261118 - Luphia) template 內容不會載入圖片或執行任何東西
  const template = document.createElement('template');
  template.innerHTML = result;
  await Promise.all(
    [...template.content.querySelectorAll('img')].map(async img => {
      const ref = img.getAttribute('src');
      if (!ref || /^(data|blob|https?):/i.test(ref)) return;
      const url = await assets.image(ref).catch(() => null);
      if (url) img.setAttribute('src', url);
      else img.replaceWith(Object.assign(document.createElement('span'), { className: 'dh-missing', textContent: `Image not found in this room: ${ref}` }));
    })
  );
  return template.innerHTML;
}

/**
 * Info: (20261118 - Luphia)
 * 單一區塊排版 (編輯器)
 */
export async function renderBlock(text: string, settings: IDocSettings, assets: IDocAssetResolver | null): Promise<string> {
  const diagrams: string[] = [];
  const html = await toHtml(text, diagrams, false);
  return finishHtml(html, diagrams, settings, assets);
}

/**
 * Info: (20261118 - Luphia)
 * 數學式即時預覽：回傳 KaTeX HTML 或錯誤訊息
 */
export async function renderMathPreview(tex: string): Promise<{ html: string; error: string | null }> {
  const katex = (await import('katex')).default;
  try {
    return { html: katex.renderToString(tex, { displayMode: true, throwOnError: true, strict: 'ignore', trust: false }), error: null };
  } catch (err) {
    return { html: '', error: err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/, '') : 'Invalid equation' };
  }
}

const SERIF = 'Georgia, "Noto Serif TC", "Noto Serif CJK TC", "Source Han Serif TC", "Songti TC", "Times New Roman", serif';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans TC", "Noto Sans CJK TC", "PingFang TC", "Microsoft JhengHei", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Info: (20261118 - Luphia)
 * 文件樣式 (編輯器的白色頁面與 PDF 共用，所見即所得)：主題色、三種版面風格、數學式編號、表格、程式碼
 * 樣式都限定在 .dh-doc 之下，不影響介面
 */
export function docCss(settings: IDocSettings): string {
  const theme = DOC_THEMES[settings.theme];
  // Info: (20261119 - Luphia) 三種版面風格；標題一律不編號
  const styles: Record<IDocSettings['style'], string> = {
    block: `.dh-doc h1{margin:0 0 1.6em;padding:1.1em 1.3em 1em;border-radius:10px;background:var(--dh-soft);box-shadow:inset .5em 0 0 var(--dh-accent);font-size:2em;font-weight:800;letter-spacing:-.01em}
.dh-doc h2{display:flex;align-items:center;gap:.5em;margin:1.9em 0 .7em;font-size:1.32em;font-weight:700}
.dh-doc h2::before{content:"";flex:none;width:.62em;height:.62em;border-radius:.14em;background:var(--dh-accent)}
.dh-doc h3{display:flex;align-items:center;gap:.45em;margin:1.5em 0 .55em;font-size:1.1em;font-weight:700}
.dh-doc h3::before{content:"";flex:none;width:.4em;height:.4em;border-radius:.1em;background:var(--dh-accent);opacity:.7}`,
    ribbon: `.dh-doc h1{margin:0 0 1.6em;padding:1em 1.2em;border-radius:6px;background:var(--dh-accent);color:#fff;font-size:1.95em;font-weight:800;letter-spacing:-.01em}
.dh-doc h2{display:flex;align-items:center;gap:.55em;margin:1.8em 0 .8em;padding:.42em .7em;border-radius:6px;background:var(--dh-soft);font-size:1.22em;font-weight:700}
.dh-doc h2::before{content:"";flex:none;width:.3em;height:1.1em;border-radius:.08em;background:var(--dh-accent)}
.dh-doc h3{margin:1.5em 0 .55em;padding-bottom:.25em;border-bottom:2px solid var(--dh-soft);color:var(--dh-accent);font-size:1.08em;font-weight:700}`,
    editorial: `.dh-doc h1{margin:0 0 1.5em;padding-bottom:.55em;font-family:${SERIF};font-size:2.3em;font-weight:700;letter-spacing:-.015em;line-height:1.15}
.dh-doc h1::after{content:"";display:block;width:3.2em;height:.16em;margin-top:.45em;border-radius:.08em;background:var(--dh-accent)}
.dh-doc h2{margin:2em 0 .65em;font-family:${SERIF};font-size:1.42em;font-weight:700}
.dh-doc h2::before{content:"";display:block;width:1.9em;height:.26em;margin-bottom:.55em;border-radius:.13em;background:var(--dh-accent)}
.dh-doc h3{margin:1.5em 0 .5em;font-family:${SERIF};font-style:italic;font-size:1.12em;font-weight:600;color:var(--dh-accent)}
.dh-doc blockquote{background:none;border:0;border-left:3px solid var(--dh-accent);padding:.2em 1.2em;font-style:italic;color:#374151;border-radius:0}`,
  };
  const heading = styles[settings.style] ?? styles.block;
  const equationNumbers = settings.equationNumbers
    ? `.dh-doc .katex-display{position:relative;padding-right:3em}
.dh-doc .katex-display::after{counter-increment:dh-eq;content:"(" counter(dh-eq) ")";position:absolute;right:0;top:50%;transform:translateY(-50%);font:.85em ${SANS};color:#6B7280}`
    : '';
  return `
.dh-doc{--dh-accent:${theme.accent};--dh-soft:${theme.soft};--dh-ink:${theme.ink};counter-reset:dh-eq;color:#1F2937;font-family:${settings.font === 'serif' ? SERIF : SANS};font-size:10.5pt;line-height:1.72;word-wrap:break-word}
.dh-doc *{box-sizing:border-box}
.dh-doc>*:first-child,.dh-doc .dh-block:first-child>*:first-child{margin-top:0}
.dh-doc h1,.dh-doc h2,.dh-doc h3,.dh-doc h4{font-family:${SANS};color:var(--dh-ink);line-height:1.25;break-after:avoid}
.dh-doc h4{margin:1.3em 0 .5em;font-size:1em}
.dh-doc p,.dh-doc ul,.dh-doc ol,.dh-doc blockquote,.dh-doc pre,.dh-doc table,.dh-doc figure{margin:0 0 1em}
.dh-doc a{color:var(--dh-accent);text-decoration:underline;text-underline-offset:2px}
.dh-doc strong{color:#111827}
.dh-doc ul,.dh-doc ol{padding-left:1.5em}
.dh-doc li+li{margin-top:.25em}
.dh-doc li::marker{color:var(--dh-accent)}
.dh-doc .contains-task-list{list-style:none;padding-left:.2em}
.dh-doc .task-list-item input{margin:0 .5em 0 0;accent-color:var(--dh-accent)}
.dh-doc blockquote{padding:10px 16px;border-radius:8px;background:var(--dh-soft);color:var(--dh-ink)}
.dh-doc blockquote>:last-child{margin-bottom:0}
.dh-doc hr{border:0;height:2px;background:var(--dh-soft);margin:24px 0}
.dh-doc img{max-width:100%;height:auto;border-radius:6px}
.dh-doc table{width:100%;border-collapse:collapse;font-family:${SANS};font-size:.88em;font-variant-numeric:tabular-nums;break-inside:avoid}
.dh-doc th{background:var(--dh-soft);color:var(--dh-ink);text-align:left;font-weight:700}
.dh-doc th,.dh-doc td{padding:7px 10px;border-bottom:1px solid #E5E7EB;vertical-align:top}
.dh-doc code{font-family:${MONO};font-size:.86em}
.dh-doc :not(pre)>code{padding:.1em .38em;border-radius:5px;background:#F1F5F9;color:#0F172A}
.dh-doc pre{padding:12px 14px;border-radius:8px;background:#F8FAFC;border:1px solid #E2E8F0;overflow:auto;line-height:1.55;break-inside:avoid}
.dh-doc .katex{font-size:1.08em}
.dh-doc .katex-display{margin:6px 0 16px;overflow-x:auto;overflow-y:hidden;break-inside:avoid}
${equationNumbers}
${heading}
.dh-doc .dh-mermaid{display:flex;justify-content:center;margin:6px 0 16px;break-inside:avoid}
.dh-doc .dh-mermaid svg{max-width:100%;height:auto}
.dh-doc .dh-error{padding:10px 12px;border-radius:8px;border:1px solid #FCA5A5;background:#FEF2F2;color:#991B1B;font:13px ${SANS}}
.dh-doc .dh-error pre{margin:6px 0 0;background:transparent;border:0;padding:0;white-space:pre-wrap;color:#991B1B}
.dh-doc .dh-missing{display:inline-block;padding:6px 10px;border-radius:6px;background:#FEF2F2;color:#991B1B;font:12px ${SANS}}
.dh-doc .dh-pagebreak{margin:20px 0;border-top:2px dashed #CBD5E1;position:relative;height:0}
.dh-doc .dh-pagebreak::after{content:"Page break";position:absolute;left:50%;top:-.75em;transform:translateX(-50%);padding:0 8px;background:#fff;color:#64748B;font:11px ${SANS}}
.dh-doc .dh-toc{margin:0 0 22px;padding:14px 18px;border-radius:10px;border:1px solid #E5E7EB;font-family:${SANS};font-size:.9em}
.dh-doc .dh-toc p{margin:0 0 6px;font-weight:700;color:var(--dh-ink)}
.dh-doc .dh-toc ol{margin:0;padding-left:1.3em}
.dh-doc .dh-toc a{color:#1F2937;text-decoration:none}
.dh-doc .dh-toc .dh-toc-sub{padding-left:1em;list-style:circle}
.dh-doc .footnotes{font-size:.85em;color:#4B5563;border-top:1px solid #E5E7EB;padding-top:10px}
.dh-doc .hljs-keyword,.dh-doc .hljs-selector-tag,.dh-doc .hljs-built_in{color:#7C3AED}
.dh-doc .hljs-string,.dh-doc .hljs-attr{color:#047857}
.dh-doc .hljs-number,.dh-doc .hljs-literal{color:#B45309}
.dh-doc .hljs-comment{color:#6B7280;font-style:italic}
.dh-doc .hljs-title,.dh-doc .hljs-function{color:#1D4ED8}
`;
}

/**
 * Info: (20261118 - Luphia)
 * 產生 PDF 用的完整 HTML (不含任何腳本與外部資源)：KaTeX 字型以 data: URI 內嵌、圖表為 SVG、圖片為 data: URI
 */
export async function renderDocumentHtml(
  source: string,
  settings: IDocSettings,
  assets: IDocAssetResolver | null,
  fallbackTitle: string
): Promise<{ html: string; title: string }> {
  const { body } = splitFrontMatter(source);
  const diagrams: string[] = [];
  let html = await finishHtml(await toHtml(body, diagrams, true), diagrams, settings, assets);

  const template = document.createElement('template');
  template.innerHTML = html;
  const h1 = template.content.querySelector('h1');
  const title = h1?.textContent?.trim() || fallbackTitle;

  if (settings.toc) {
    const headings = [...template.content.querySelectorAll('h2, h3')];
    if (headings.length > 0) {
      const items = headings
        .map(h => `<li${h.tagName === 'H3' ? ' class="dh-toc-sub"' : ''}><a href="#${escapeHtml(h.id)}">${escapeHtml(h.textContent || '')}</a></li>`)
        .join('');
      const nav = document.createElement('nav');
      nav.className = 'dh-toc';
      nav.innerHTML = `<p>Contents</p><ol>${items}</ol>`;
      if (h1) h1.after(nav);
      else template.content.prepend(nav);
    }
  }
  if (settings.titlePage && h1) {
    const cover = document.createElement('section');
    cover.className = 'dh-cover';
    h1.replaceWith(cover);
    cover.appendChild(h1);
  }
  html = template.innerHTML;

  let katexCss = '';
  if (html.includes('class="katex')) katexCss = await loadKatexCss().catch(() => '');

  const page = settings.paper === 'letter' ? 'Letter' : 'A4';
  const margin = MARGIN_SIZES[settings.margins];
  const css = `${docCss(settings)}
@page{size:${page};margin:${margin}}
html,body{margin:0;background:#fff}
.dh-doc .dh-pagebreak{break-after:page;border:0;margin:0}
.dh-doc .dh-pagebreak::after{content:none}
.dh-doc .dh-cover{min-height:220mm;display:flex;flex-direction:column;justify-content:center;break-after:page}
.dh-doc .dh-cover h1{font-size:2.6em;padding:40px 36px}
.dh-doc a{text-decoration:none}
.dh-doc tr,.dh-doc img{break-inside:avoid}`;
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style>${katexCss ? `<style>${katexCss}</style>` : ''}</head><body><article class="dh-doc">${html}</article></body></html>`;
  return { html: doc, title };
}
