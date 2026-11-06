import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGemoji from 'remark-gemoji';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import type { Root as MdastRoot, RootContent, Parent as MdastParent } from 'mdast';
import type { Root as HastRoot, Element as HastElement, ElementContent } from 'hast';
// Info: (20261106 - Luphia) 化學式 \ce{…} 與單位 \pu{…} (註冊到 rehype-katex 共用的 katex)
import 'katex/contrib/mhchem';

/**
 * Info: (20261106 - Luphia)
 * Markdown → HTML (瀏覽器端，動態載入)
 * - GFM：表格、工作清單、刪除線、自動連結、註腳
 * - 數學式：$…$、$$…$$ 與 ```math 區塊，以 KaTeX 排版 (含 \ce 化學式、\tag 編號)；
 *   KaTeX 字型以 data: URI 內嵌 (sandbox 只允許 data: 字型)，載入失敗時改用瀏覽器原生 MathML
 * - 圖表：```mermaid 區塊在主頁面以 mermaid (securityLevel: strict) 轉為 SVG 後內嵌
 * - 程式碼高亮、GitHub 提示區塊 (> [!NOTE] 等)、:emoji: 短碼、標題錨點；front matter 不顯示
 * - 產生的 HTML 仍交給 html_preview 的 sandbox + CSP 呈現，原始 HTML 中的腳本預設會被移除
 */

export interface IMarkdownRenderResult {
  html: string;
  title: string;
  diagrams: number;
  diagramErrors: number;
}

const ALERT_TITLES: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

const MERMAID_PLACEHOLDER = (index: number) => `<!--dh-mermaid-${index}-->`;

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function walk(node: MdastRoot | RootContent, visit: (node: RootContent, parent: MdastParent, index: number) => void) {
  if (!('children' in node)) return;
  const parent = node as MdastParent;
  // Info: (20261106 - Luphia) 由後往前走訪，允許 visit 中替換目前節點
  for (let i = parent.children.length - 1; i >= 0; i--) {
    const child = parent.children[i] as RootContent;
    visit(child, parent, i);
    walk(parent.children[i] as RootContent, visit);
  }
}

/**
 * Info: (20261106 - Luphia)
 * 將 ```mermaid 換成佔位註解 (之後替換為 SVG)、
 * GitHub 提示區塊轉為帶樣式的 div
 */
function remarkDropHereBlocks(diagrams: string[]) {
  return () => (tree: MdastRoot) => {
    const found: { parent: MdastParent; index: number; code: string }[] = [];
    walk(tree, (node, parent, index) => {
      if (node.type === 'code') {
        const lang = (node.lang || '').toLowerCase();
        // Info: (20261106 - Luphia) ```math 由 rehype-katex 直接處理 (language-math)
        if (lang === 'mermaid') found.push({ parent, index, code: node.value });
        return;
      }
      if (node.type !== 'blockquote') return;
      const first = node.children[0];
      if (first?.type !== 'paragraph') return;
      const text = first.children[0];
      if (text?.type !== 'text') return;
      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\r?\n)?/i.exec(text.value);
      if (!match) return;
      const kind = match[1].toUpperCase();
      text.value = text.value.slice(match[0].length);
      if (!text.value) first.children.shift();
      if (first.children.length === 0) node.children.shift();
      node.data = { hName: 'div', hProperties: { className: ['md-alert', `md-alert-${kind.toLowerCase()}`] } };
      node.children.unshift({
        type: 'paragraph',
        data: { hProperties: { className: ['md-alert-title'] } },
        children: [{ type: 'text', value: ALERT_TITLES[kind] }],
      });
    });
    // Info: (20261106 - Luphia) 依文件順序編號
    found.reverse().forEach(({ parent, index, code }) => {
      parent.children[index] = { type: 'html', value: MERMAID_PLACEHOLDER(diagrams.length) } as RootContent;
      diagrams.push(code);
    });
  };
}

/**
 * Info: (20261106 - Luphia)
 * 表格排版：外層加可水平捲動的容器；儲存格內容包一層 div 限制最大寬度，
 * 數值與公式不換行、長文字在 32em 處換行
 */
function rehypeScientificTables() {
  const visit = (node: HastRoot | HastElement) => {
    node.children.forEach((child, index) => {
      if (child.type !== 'element') return;
      if (child.tagName === 'table' && !(node.type === 'element' && (node.properties?.className as string[] | undefined)?.includes('md-table'))) {
        const wrapper: HastElement = {
          type: 'element',
          tagName: 'div',
          properties: { className: ['md-table'] },
          children: [child],
        };
        node.children[index] = wrapper;
      }
      if (child.tagName === 'td' || child.tagName === 'th') {
        child.children = [
          { type: 'element', tagName: 'div', properties: { className: ['md-cell'] }, children: child.children as ElementContent[] },
        ];
        return;
      }
      visit(child);
    });
  };
  return (tree: HastRoot) => visit(tree);
}

type TMermaid = (typeof import('mermaid'))['default'];
let mermaidPromise: Promise<TMermaid> | null = null;

const loadMermaid = (): Promise<TMermaid> => {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(module => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // Info: (20261106 - Luphia) 深色主題，配色與 DropHere 介面一致 (slate 底、blue 主色)
        theme: 'base',
        themeVariables: {
          darkMode: true,
          background: '#020617',
          fontSize: '14px',
          primaryColor: '#172554',
          primaryBorderColor: '#3b82f6',
          primaryTextColor: '#e2e8f0',
          secondaryColor: '#1e293b',
          secondaryBorderColor: '#64748b',
          secondaryTextColor: '#e2e8f0',
          tertiaryColor: '#0f172a',
          tertiaryBorderColor: '#334155',
          tertiaryTextColor: '#cbd5e1',
          lineColor: '#94a3b8',
          textColor: '#cbd5e1',
          mainBkg: '#172554',
          nodeBorder: '#3b82f6',
          clusterBkg: '#0f172a',
          clusterBorder: '#334155',
          edgeLabelBackground: '#0b1222',
          actorBkg: '#172554',
          actorBorder: '#3b82f6',
          actorTextColor: '#e2e8f0',
          actorLineColor: '#475569',
          signalColor: '#cbd5e1',
          signalTextColor: '#e2e8f0',
          labelBoxBkgColor: '#1e293b',
          labelBoxBorderColor: '#475569',
          labelTextColor: '#e2e8f0',
          loopTextColor: '#cbd5e1',
          noteBkgColor: '#422006',
          noteBorderColor: '#d97706',
          noteTextColor: '#fef3c7',
          activationBkgColor: '#1e3a8a',
          activationBorderColor: '#60a5fa',
          xyChart: {
            backgroundColor: '#020617',
            titleColor: '#f1f5f9',
            xAxisLabelColor: '#94a3b8',
            xAxisTitleColor: '#cbd5e1',
            xAxisTickColor: '#475569',
            xAxisLineColor: '#475569',
            yAxisLabelColor: '#94a3b8',
            yAxisTitleColor: '#cbd5e1',
            yAxisTickColor: '#475569',
            yAxisLineColor: '#475569',
            plotColorPalette: '#60a5fa, #fbbf24, #34d399, #f87171, #a78bfa, #38bdf8',
          },
        },
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
};

let renderCounter = 0;

const KATEX_BASE = '/vendor/katex/';
let katexCssPromise: Promise<string> | null = null;

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * Info: (20261106 - Luphia)
 * 取得 KaTeX 樣式並把 woff2 字型轉為 data: URI (只做一次)
 */
const loadKatexCss = (): Promise<string> => {
  if (!katexCssPromise) {
    katexCssPromise = (async () => {
      const res = await fetch(`${KATEX_BASE}katex.min.css`);
      if (!res.ok) throw new Error('KaTeX stylesheet unavailable');
      const css = await res.text();
      const fontNames = [...new Set([...css.matchAll(/url\(fonts\/([^)]+\.woff2)\)/g)].map(m => m[1]))];
      const entries = await Promise.all(
        fontNames.map(async name => {
          const font = await fetch(`${KATEX_BASE}fonts/${name}`);
          if (!font.ok) throw new Error(`KaTeX font ${name} unavailable`);
          return [name, await blobToDataUrl(new Blob([await font.arrayBuffer()], { type: 'font/woff2' }))] as const;
        })
      );
      const dataUrls = Object.fromEntries(entries);
      // Info: (20261106 - Luphia) 每個 @font-face 只保留 woff2 來源
      return css.replace(/src:([^;}]+)/g, (whole, sources: string) => {
        const match = /url\(fonts\/([^)]+\.woff2)\)/.exec(sources);
        return match && dataUrls[match[1]] ? `src:url(${dataUrls[match[1]]}) format("woff2")` : whole;
      });
    })().catch(err => {
      katexCssPromise = null;
      throw err;
    });
  }
  return katexCssPromise;
};

// Info: (20261106 - Luphia) 粗略判斷文件是否含數學式，避免沒有數學式時載入字型
const MATH_HINT = /\$|```\s*math|\\\(|\\\[/;

async function renderDiagrams(diagrams: string[]): Promise<{ svgs: string[]; errors: number }> {
  if (diagrams.length === 0) return { svgs: [], errors: 0 };
  const mermaid = await loadMermaid();
  const svgs: string[] = [];
  let errors = 0;
  // Info: (20261106 - Luphia) mermaid 不支援並行繪製，逐一處理
  for (const code of diagrams) {
    const id = `dh-mermaid-${Date.now().toString(36)}-${renderCounter++}`;
    try {
      const { svg } = await mermaid.render(id, code);
      svgs.push(`<figure class="md-mermaid">${svg}</figure>`);
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      svgs.push(
        `<div class="md-mermaid-error"><p><strong>Mermaid diagram could not be rendered</strong></p><pre>${escapeHtml(message)}</pre><pre><code>${escapeHtml(code)}</code></pre></div>`
      );
    } finally {
      // Info: (20261106 - Luphia) 清除 mermaid 失敗時留在主頁面的暫存節點
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }
  return { svgs, errors };
}

export async function renderMarkdown(markdown: string, fallbackTitle: string): Promise<IMarkdownRenderResult> {
  const diagrams: string[] = [];
  let katexCss = '';
  if (MATH_HINT.test(markdown)) {
    try {
      katexCss = await loadKatexCss();
    } catch {
      // Info: (20261106 - Luphia) 改用 MathML 輸出
    }
  }

  const file = await unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkGemoji)
    .use(remarkDropHereBlocks(diagrams))
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeScientificTables)
    .use(rehypeKatex, { output: katexCss ? 'htmlAndMathml' : 'mathml', strict: 'ignore', trust: false })
    .use(rehypeHighlight, { detect: false, ignoreMissing: true } as Parameters<typeof rehypeHighlight>[0])
    .use(rehypeStringify)
    .process(markdown);

  let body = String(file);
  const { svgs, errors } = await renderDiagrams(diagrams);
  svgs.forEach((svg, index) => {
    body = body.replace(MERMAID_PLACEHOLDER(index), () => svg);
  });

  const usesKatex = katexCss && body.includes('class="katex');

  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
  const title = heading ? heading[1].replace(/<[^>]+>/g, '').trim() : fallbackTitle;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${MARKDOWN_CSS}</style>${usesKatex ? `<style>${katexCss}</style>` : ''}</head><body><article class="markdown-body">${body}</article></body></html>`;
  return { html, title, diagrams: diagrams.length, diagramErrors: errors };
}

// Info: (20261106 - Luphia) 與 DropHere 介面一致的深色版面 (slate / blue)；列印時改為白底黑字
// Info: (20261106 - Luphia) 內嵌樣式：iframe 的 CSP 不允許外部樣式；字型使用系統字型以符合介面
const MARKDOWN_CSS = `
:root{color-scheme:dark;--bg:#0b1222;--surface:#0f172a;--surface-2:#111a2e;--sunken:#020617;--border:rgba(148,163,184,.16);--border-strong:rgba(148,163,184,.28);--text:#cbd5e1;--strong:#f1f5f9;--muted:#94a3b8;--accent:#60a5fa;--accent-strong:#93c5fd;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI","Noto Sans TC","PingFang TC",Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;color:var(--text);font-family:var(--sans);font-size:15px;line-height:1.75;word-wrap:break-word;-webkit-font-smoothing:antialiased}
::selection{background:rgba(59,130,246,.35);color:#fff}
.markdown-body{max-width:860px;margin:0 auto;padding:40px 44px 72px}
.markdown-body>*:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{margin:32px 0 14px;color:var(--strong);font-weight:700;line-height:1.3;letter-spacing:-.01em;scroll-margin-top:16px}
h1{font-size:1.9em;margin-top:0;padding-bottom:14px;border-bottom:1px solid var(--border)}
h2{font-size:1.4em;padding-bottom:10px;border-bottom:1px solid var(--border)}
h3{font-size:1.15em}h4{font-size:1em}h5{font-size:.9em}h6{font-size:.8em;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
h1::before,h2::before,h3::before,h4::before{content:"";display:inline-block;flex:none;margin-right:.55em;border-radius:3px;vertical-align:-.08em}
h1::before{width:6px;height:.95em;background:#3b82f6}
h2::before{width:5px;height:.9em;background:#60a5fa}
h3::before{width:4px;height:.85em;background:#38bdf8}
h4::before{width:3px;height:.8em;background:#94a3b8}
p,blockquote,ul,ol,dl,pre,details,.md-alert,figure,.md-table{margin:0 0 16px}
strong{color:var(--strong);font-weight:600}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(96,165,250,.35)}
a:hover{color:var(--accent-strong);border-bottom-color:var(--accent-strong)}
a.data-footnote-backref,sup a{border-bottom:0}
ul,ol{padding-left:1.6em}li+li{margin-top:.3em}li::marker{color:var(--muted)}
.contains-task-list{padding-left:.4em;list-style:none}
.task-list-item input[type=checkbox]{width:15px;height:15px;margin:0 .55em .2em 0;vertical-align:middle;accent-color:#2563eb}
blockquote{padding:2px 0 2px 16px;color:var(--muted);border-left:3px solid #334155}
hr{height:1px;margin:28px 0;padding:0;background:var(--border);border:0}
img{max-width:100%;height:auto;border-radius:8px}
code,kbd,pre,samp{font-family:var(--mono);font-size:.86em}
:not(pre)>code{padding:.15em .45em;border-radius:6px;color:#e2e8f0;background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.12)}
pre{padding:16px 18px;overflow:auto;line-height:1.6;background:var(--sunken);border:1px solid var(--border);border-radius:12px}
pre code{font-size:100%;background:transparent;padding:0;border:0;color:#e2e8f0}
kbd{display:inline-block;padding:2px 6px;line-height:1.2;color:var(--strong);background:#1e293b;border:1px solid #334155;border-bottom-width:2px;border-radius:6px}
details{padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
details summary{cursor:pointer;color:var(--strong);font-weight:600}
details[open] summary{margin-bottom:8px}
mark{background:rgba(250,204,21,.25);color:#fef9c3;border-radius:3px;padding:0 2px}
del{color:var(--muted)}
.md-table{max-width:100%;overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
table{width:max-content;min-width:100%;border-spacing:0;border-collapse:collapse;border-style:hidden;font-variant-numeric:tabular-nums lining-nums;font-size:.94em}
.md-table table{margin:0}
th,td{padding:9px 14px;border:1px solid var(--border);vertical-align:middle}
th{color:var(--strong);font-weight:600;background:var(--surface-2);text-align:left}
tbody tr:nth-child(2n){background:rgba(148,163,184,.04)}
tbody tr:hover{background:rgba(59,130,246,.10)}
td[align=right],th[align=right]{text-align:right}td[align=center],th[align=center]{text-align:center}
td{color:#e2e8f0}
.md-cell{max-width:32em}
.footnotes{font-size:.88em;color:var(--muted);border-top:1px solid var(--border);padding-top:16px;margin-top:36px}
.footnotes ol{padding-left:1.4em}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
math[display=block]{display:block;overflow-x:auto;margin:0 0 16px;font-size:1.1em}
.katex{font-size:1.08em;color:#e2e8f0}
.katex-display{margin:0 0 16px;padding:10px 0;overflow-x:auto;overflow-y:hidden}
.katex-display>.katex{max-width:100%;color:var(--strong)}
.katex-error{color:#fca5a5;font-family:var(--mono);font-size:85%}
.md-mermaid{display:flex;justify-content:center;overflow-x:auto;padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--sunken)}
.md-mermaid svg{max-width:100%;height:auto}
.md-mermaid-error{padding:14px 16px;border:1px solid rgba(248,113,113,.4);border-radius:12px;background:rgba(127,29,29,.25);color:#fecaca}
.md-mermaid-error pre{background:rgba(2,6,23,.6);margin:10px 0 0;color:#fecaca}
.md-alert{padding:12px 16px;border:1px solid;border-left-width:3px;border-radius:12px}
.md-alert>:last-child{margin-bottom:0}
.md-alert-title{font-weight:700;font-size:.82em;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}
.md-alert-note{border-color:rgba(59,130,246,.45);background:rgba(37,99,235,.10)}.md-alert-note .md-alert-title{color:#93c5fd}
.md-alert-tip{border-color:rgba(16,185,129,.45);background:rgba(5,150,105,.10)}.md-alert-tip .md-alert-title{color:#6ee7b7}
.md-alert-important{border-color:rgba(139,92,246,.45);background:rgba(124,58,237,.10)}.md-alert-important .md-alert-title{color:#c4b5fd}
.md-alert-warning{border-color:rgba(245,158,11,.45);background:rgba(217,119,6,.10)}.md-alert-warning .md-alert-title{color:#fcd34d}
.md-alert-caution{border-color:rgba(239,68,68,.45);background:rgba(220,38,38,.10)}.md-alert-caution .md-alert-title{color:#fca5a5}
.hljs{color:#e2e8f0}
.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-variable.language_{color:#f472b6}
.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#a78bfa}
.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#fbbf24}
.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#34d399}
.hljs-built_in,.hljs-symbol,.hljs-type{color:#38bdf8}
.hljs-code,.hljs-comment,.hljs-formula{color:#8b98ad;font-style:italic}
.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#60a5fa}
.hljs-subst{color:#e2e8f0}
.hljs-section{color:#93c5fd;font-weight:700}
.hljs-bullet{color:#fb923c}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:700}
.hljs-addition{color:#86efac;background:rgba(22,163,74,.15)}.hljs-deletion{color:#fca5a5;background:rgba(220,38,38,.15)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:#1e293b;border-radius:999px;border:2px solid var(--bg)}::-webkit-scrollbar-track{background:transparent}
@media (max-width:640px){.markdown-body{padding:24px 18px 48px}body{font-size:14.5px}}
@media print{
:root{color-scheme:light;--bg:#fff;--surface:#fff;--surface-2:#f1f5f9;--sunken:#f8fafc;--border:#cbd5e1;--text:#1e293b;--strong:#0f172a;--muted:#475569;--accent:#1d4ed8}
.markdown-body{padding:0;max-width:none}
:not(pre)>code,pre code,td,.katex,.katex-display>.katex,kbd{color:#0f172a}
:not(pre)>code{background:#f1f5f9}kbd{background:#f1f5f9;border-color:#cbd5e1}
.md-table{overflow:visible;border:0}table{width:auto;min-width:0}.md-cell{max-width:none}
.hljs,.hljs *{color:#0f172a!important}
a{border-bottom:0}
}
`;
