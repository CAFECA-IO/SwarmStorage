'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { IRoomFileResolver } from '@/lib/html_preview';
import { dirOf, matchRoomFile } from '@/lib/html_preview';
import { DOC_STYLES, DOC_THEMES, MARGIN_SIZES, PAPER_LABELS, PAPER_WIDTHS, type TDocStyle, joinFrontMatter, readDocSettings, splitFrontMatter, writeDocSettings, type IDocSettings, type TDocTheme } from '@/lib/doc_settings';
import { docCss, joinBlocks, renderBlock, renderDiagram, renderDocumentHtml, renderMathPreview, type IDocAssetResolver } from '@/lib/doc_render';
import { pdfNameFor, printDocument, requestPdf } from '@/lib/doc_store';
import { getFileKind } from '@/lib/file_types';
import { useDocSession, type IDocPerson } from '@/lib/use_doc_session';
import type { IRoomChat } from '@/lib/use_room_chat';
import type { TDocAccess, TSectionStatus } from '@/lib/doc_hub';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

interface IInsertItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  template: string;
  // Info: (20261118 - Luphia) 插入後游標位置 (從開頭算起)
  caret?: number;
}

const INSERT_ITEMS: IInsertItem[] = [
  { id: 'equation', label: 'Equation', hint: '$$', keywords: 'equation math latex formula', template: '$$\n\\frac{a}{b}\n$$', caret: 3 },
  { id: 'mermaid', label: 'Mermaid diagram', hint: '```mermaid', keywords: 'mermaid diagram chart flow sequence', template: '```mermaid\nflowchart LR\n  A[Start] --> B[Next step]\n```', caret: 25 },
  { id: 'table', label: 'Table', hint: '| a | b |', keywords: 'table grid', template: '| Column | Column |\n| --- | --- |\n|  |  |', caret: 2 },
  { id: 'image', label: 'Image from this room', hint: '![]()', keywords: 'image picture figure photo', template: '' },
  { id: 'heading', label: 'Heading', hint: '##', keywords: 'heading title section h2', template: '## ', caret: 3 },
  { id: 'subheading', label: 'Subheading', hint: '###', keywords: 'subheading h3', template: '### ', caret: 4 },
  { id: 'checklist', label: 'Checklist', hint: '- [ ]', keywords: 'checklist todo task', template: '- [ ] ', caret: 6 },
  { id: 'code', label: 'Code block', hint: '```', keywords: 'code snippet', template: '```\n\n```', caret: 4 },
  { id: 'chemistry', label: 'Chemical equation', hint: '\\ce', keywords: 'chemistry chemical reaction ce', template: '$$\n\\ce{2H2 + O2 -> 2H2O}\n$$', caret: 3 },
  { id: 'pagebreak', label: 'Page break', hint: 'PDF', keywords: 'page break pagebreak', template: '<!-- pagebreak -->' },
];

const MATH_SNIPPETS: { label: string; tex: string; aria: string }[] = [
  { label: 'a/b', tex: '\\frac{}{}', aria: 'Fraction' },
  { label: '√x', tex: '\\sqrt{}', aria: 'Square root' },
  { label: 'xⁿ', tex: '^{}', aria: 'Superscript' },
  { label: 'xₙ', tex: '_{}', aria: 'Subscript' },
  { label: '∫', tex: '\\int_{a}^{b} ', aria: 'Integral' },
  { label: '∑', tex: '\\sum_{i=1}^{n} ', aria: 'Sum' },
  { label: 'lim', tex: '\\lim_{x \\to 0} ', aria: 'Limit' },
  { label: '[ ]', tex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', aria: 'Matrix' },
  { label: 'α', tex: '\\alpha', aria: 'Alpha' },
  { label: 'Δ', tex: '\\Delta', aria: 'Delta' },
  { label: '→', tex: '\\rightarrow', aria: 'Arrow' },
  { label: 'H₂O', tex: '\\ce{H2O}', aria: 'Chemical formula' },
];

const IMAGE_KINDS = new Set(['image']);

const relativePath = (fromDir: string, target: string) => {
  const from = fromDir ? fromDir.split('/') : [];
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...new Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const mathBody = (block: string) => {
  const match = /^\$\$\s*\n?([\s\S]*?)\n?\s*\$\$\s*$/.exec(block.trim());
  return match ? match[1] : block;
};
const mermaidBody = (block: string) => {
  const match = /^```mermaid[^\n]*\n([\s\S]*?)\n?```\s*$/i.exec(block.trim());
  return match ? match[1] : '';
};

const formatAgo = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
};


const NEW_BLOCK = '__new__';

const STATUS_LABELS: Record<TSectionStatus, string> = { todo: 'To write', writing: 'Writing', review: 'In review', done: 'Done' };
const STATUS_TONES: Record<TSectionStatus, string> = {
  todo: 'bg-slate-100 text-slate-700 border-slate-300',
  writing: 'bg-blue-50 text-blue-800 border-blue-300',
  review: 'bg-amber-50 text-amber-900 border-amber-300',
  done: 'bg-emerald-50 text-emerald-800 border-emerald-300',
};
const STATUS_DOTS: Record<TSectionStatus, string> = { todo: 'bg-slate-400', writing: 'bg-blue-500', review: 'bg-amber-500', done: 'bg-emerald-500' };
const HISTORY_LABELS: Record<string, string> = {
  edit: 'edited',
  insert: 'added',
  delete: 'removed',
  settings: 'changed the PDF settings',
  rewrite: 'rewrote the whole document',
  restore: 'restored',
};

// Info: (20261118 - Luphia) 依名字給每個人固定的顏色 (編輯鎖、頭像)
const PERSON_COLORS = ['#2563EB', '#0F766E', '#C2410C', '#7C3AED', '#BE185D', '#4D7C0F', '#0369A1', '#B45309'];
const colorOf = (key: string) => PERSON_COLORS[[...key].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PERSON_COLORS.length];
const initialsOf = (name: string) => name.replace(/^@/, '').split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

const headingDepth = (text: string) => {
  const match = /^(#{1,6})\s/.exec(text);
  return match ? match[1].length : null;
};
const kindOfText = (text: string): string => {
  if (headingDepth(text)) return 'heading';
  if (text.startsWith('$$')) return 'math';
  if (/^```mermaid/i.test(text)) return 'mermaid';
  if (/^```/.test(text)) return 'code';
  if (/^\|/.test(text)) return 'table';
  if (/^([-*+]|\d+\.)\s/.test(text)) return 'list';
  return 'paragraph';
};
const snippet = (text: string | null, max = 90) => {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export interface IDocEditorProps {
  roomId: string;
  password: string | null;
  filename: string;
  // Info: (20261118 - Luphia) 新文件的內容 (伺服器建立後開啟)；null 表示開啟既有文件
  createSource: string | null;
  chat: IRoomChat;
  resolver: IRoomFileResolver;
  onClose: () => void;
  onUploadPdf: (file: File, path: string) => void;
  onToast: (message: string, tone: 'info' | 'success' | 'error') => void;
}

interface IEditing {
  id: string;
  afterId: string | null;
  draft: string;
  original: string;
  caret: 'start' | 'end';
}

type TPanel = 'sections' | 'comments' | 'history' | 'pdf';

/**
 * Info: (20261118 - Luphia)
 * 文件編輯器 (B 方案：直接在頁面上寫) + 共筆
 * - 文件由伺服器保存並即時同步；點一段即取得該段的編輯鎖，其他人看到「誰正在編輯」
 * - 分工：## 章節可指派負責人與進度 (待寫 / 撰寫中 / 待審 / 完成)；可設定「只有負責人能改自己的章節」
 * - 段落留言 (回覆、標記已解決)、修改紀錄 (誰在何時改了什麼，可還原)
 * - 空白行輸入 / 插入數學式、Mermaid、表格、房間圖片；數學式與圖表即時預覽
 * - PDF：主題色、標題色塊、紙張、字體、邊界、頁碼、目錄、封面頁、數學式編號 (存在文件 front matter)
 */
// Info: (20261119 - Luphia) 版面風格的小示意圖
function StyleThumb({ style, accent, soft }: { style: TDocStyle; accent: string; soft: string }) {
  return (
    <svg width="44" height="56" viewBox="0 0 44 56" aria-hidden="true" className="shrink-0 rounded-[4px] bg-white">
      {style === 'block' && (
        <>
          <rect x="5" y="5" width="34" height="10" rx="2" fill={soft} />
          <rect x="5" y="5" width="2.5" height="10" fill={accent} />
          <rect x="5" y="21" width="4" height="4" rx="1" fill={accent} />
          <rect x="11" y="22" width="18" height="2.5" rx="1" fill="#334155" />
        </>
      )}
      {style === 'ribbon' && (
        <>
          <rect x="5" y="5" width="34" height="10" rx="1.5" fill={accent} />
          <rect x="5" y="20" width="34" height="6" rx="1.5" fill={soft} />
          <rect x="7" y="21.5" width="1.6" height="3" fill={accent} />
          <rect x="10.5" y="22" width="16" height="2" rx="1" fill="#334155" />
        </>
      )}
      {style === 'editorial' && (
        <>
          <rect x="5" y="6" width="28" height="5" rx="1" fill="#111827" />
          <rect x="5" y="13" width="9" height="1.6" rx=".8" fill={accent} />
          <rect x="5" y="21" width="6" height="1.4" rx=".7" fill={accent} />
          <rect x="5" y="24" width="20" height="2.5" rx="1" fill="#334155" />
        </>
      )}
      <rect x="5" y="31" width="34" height="1.6" rx=".8" fill="#CBD5E1" />
      <rect x="5" y="35" width="30" height="1.6" rx=".8" fill="#CBD5E1" />
      <rect x="5" y="39" width="32" height="1.6" rx=".8" fill="#CBD5E1" />
      <rect x="5" y="43" width="22" height="1.6" rx=".8" fill="#CBD5E1" />
    </svg>
  );
}

export default function DocEditor({ roomId, password, filename, createSource, chat, resolver, onClose, onUploadPdf, onToast }: IDocEditorProps) {
  const { doc, status, error, saveError, act, refreshMembers } = useDocSession({ roomId, filename, chat, createSource });
  const [editing, setEditing] = useState<IEditing | null>(null);
  // Info: (20261118 - Luphia) 每段的排版結果 (key = 主題)；換主題時先顯示舊的，排好再替換，避免閃爍
  const [rendered, setRendered] = useState<Record<string, { key: string; html: string }>>({});
  const [markdownDraft, setMarkdownDraft] = useState<string | null>(null);
  const [panel, setPanel] = useState<TPanel>('sections');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [imagePicker, setImagePicker] = useState(false);
  const [pdfState, setPdfState] = useState<'idle' | 'building' | 'uploading'>('idle');
  const [alsoToRoom, setAlsoToRoom] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [mathPreview, setMathPreview] = useState<{ html: string; error: string | null } | null>(null);
  const [mermaidPreview, setMermaidPreview] = useState<{ svg: string; error: string | null } | null>(null);
  const [selection, setSelection] = useState<[number, number]>([0, 0]);
  const [pendingCaret, setPendingCaret] = useState<{ pos: number; token: number } | null>(null);
  const [commentTarget, setCommentTarget] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageCache = useRef(new Map<string, Promise<string | null>>());
  const caretPlaced = useRef<string>('');
  const appliedCaret = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const blocks = useMemo(() => doc?.blocks ?? [], [doc?.blocks]);
  // Info: (20261118 - Luphia) 設定變更先在畫面套用，等伺服器的修改送達 (rev 前進) 後改用伺服器版本
  const [optimisticFront, setOptimisticFront] = useState<{ front: string | null; rev: number } | null>(null);
  const front = optimisticFront && doc && optimisticFront.rev === doc.rev ? optimisticFront.front : (doc?.front ?? null);
  const source = useMemo(() => joinFrontMatter(front, joinBlocks(blocks.map(b => b.text))), [front, blocks]);
  const settings = useMemo(() => readDocSettings(joinFrontMatter(front, '')), [front]);
  const sKey = `${settings.theme}|${settings.style}`;

  // Info: (20261118 - Luphia) 章節：## 標題與其下的區塊
  const sectionOfBlock = useMemo(() => {
    const map: Record<string, string | null> = {};
    let current: string | null = null;
    blocks.forEach(b => {
      const depth = headingDepth(b.text);
      if (depth === 2) current = b.id;
      else if (depth === 1) current = null;
      map[b.id] = current;
    });
    return map;
  }, [blocks]);
  const sections = useMemo(
    () => blocks.filter(b => headingDepth(b.text) === 2).map(b => ({ id: b.id, title: b.text.replace(/^##\s+/, '').trim() || 'Untitled section' })),
    [blocks]
  );

  const me = doc?.me;
  const access = doc?.access ?? 'everyone';
  const canEditAll = !!me && me.canWrite && (me.manager || access === 'everyone');
  const canEditBlock = (id: string | null) => {
    if (!me || !me.canWrite) return false;
    if (me.manager || access === 'everyone') return true;
    const section = id ? sectionOfBlock[id] : null;
    return !!section && doc?.sections[section]?.assignee?.id === me.id;
  };
  const canAssign = !!me && (me.manager || (access === 'everyone' && me.canWrite));
  const canSetStatus = (sectionId: string) => !!me && (canAssign || doc?.sections[sectionId]?.assignee?.id === me.id);
  const lockedByOther = (id: string) => {
    const lock = doc?.locks[id];
    return lock && lock.memberId !== me?.memberId ? lock : null;
  };

  const assets = useMemo<IDocAssetResolver>(() => {
    const names = new Set(resolver.filenames);
    const baseDir = dirOf(filename);
    return {
      image: (ref: string) => {
        const match = matchRoomFile(ref, names, baseDir);
        if (!match || resolver.sizeOf(match) > MAX_IMAGE_BYTES) return Promise.resolve(null);
        let cached = imageCache.current.get(match);
        if (!cached) {
          cached = resolver
            .load(match)
            .then(blob => blobToDataUrl(blob))
            .catch(() => null);
          imageCache.current.set(match, cached);
        }
        return cached;
      },
    };
  }, [filename, resolver]);

  // Info: (20261118 - Luphia) 排版尚未排過的區塊 (同內容同主題只排一次)
  useEffect(() => {
    let cancelled = false;
    const missing = [...new Set(blocks.map(b => b.text))].filter(text => rendered[text]?.key !== sKey);
    if (missing.length === 0) return;
    (async () => {
      const next: Record<string, { key: string; html: string }> = {};
      for (const text of missing) {
        try {
          next[text] = { key: sKey, html: await renderBlock(text, settings, assets) };
        } catch (err) {
          next[text] = { key: sKey, html: `<div class="dh-error">${err instanceof Error ? err.message : 'Could not render this part'}</div>` };
        }
        if (cancelled) return;
      }
      setRendered(prev => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [blocks, sKey, settings, assets, rendered]);

  // Info: (20261118 - Luphia) 編輯中每 20 秒續約編輯鎖
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (!editingId || editingId === NEW_BLOCK) return;
    const timer = setInterval(async () => {
      const result = await act({ action: 'renew', id: editingId });
      if (!result.ok) onToast(result.message, 'error');
    }, 20 * 1000);
    return () => clearInterval(timer);
  }, [act, editingId, onToast]);

  // Info: (20261118 - Luphia) 正在編輯的區塊被別人刪除或整份改寫：結束編輯
  useEffect(() => {
    if (!editingId || editingId === NEW_BLOCK || blocks.some(b => b.id === editingId)) return;
    const timer = setTimeout(() => {
      setEditing(null);
      onToast('The part you were editing was removed by someone else.', 'error');
    }, 0);
    return () => clearTimeout(timer);
  }, [blocks, editingId, onToast]);

  const commitEditing = useCallback(async () => {
    const current = editing;
    if (!current) return;
    setEditing(null);
    setImagePicker(false);
    setMathPreview(null);
    setMermaidPreview(null);
    const draft = current.draft.replace(/\s+$/, '');
    const isSlash = /^\/\S*$/.test(draft.trim());
    if (current.id === NEW_BLOCK) {
      if (!draft.trim() || isSlash) return;
      const result = await act({ action: 'insert', afterId: current.afterId, text: draft });
      if (!result.ok) onToast(result.message, 'error');
      return;
    }
    if (draft === current.original.replace(/\s+$/, '') || isSlash) {
      act({ action: 'unlock', id: current.id });
      return;
    }
    const result = await act({ action: 'commit', id: current.id, text: draft });
    if (!result.ok) onToast(result.message, 'error');
  }, [act, editing, onToast]);

  const startEditing = async (id: string, caret: 'start' | 'end' = 'end') => {
    if (editing) {
      if (editing.id === id) return;
      await commitEditing();
    }
    const lock = lockedByOther(id);
    if (lock) {
      onToast(`${lock.name} is editing this part.`, 'info');
      return;
    }
    if (!canEditBlock(id)) {
      if (me?.canWrite && access === 'assignees') onToast('Only the person assigned to this section can edit it.', 'info');
      return;
    }
    const result = await act({ action: 'lock', id });
    if (!result.ok) {
      onToast(result.message, 'error');
      return;
    }
    const text = String(result.data.text ?? '');
    setEditing({ id, afterId: null, draft: text, original: text, caret });
    setMenuIndex(0);
  };

  const startNew = async () => {
    const afterId = blocks.length ? blocks[blocks.length - 1].id : null;
    if (editing) await commitEditing();
    if (!(afterId ? canEditBlock(afterId) : canEditAll)) {
      onToast('You can only add to the sections assigned to you.', 'info');
      return;
    }
    setEditing({ id: NEW_BLOCK, afterId, draft: '', original: '', caret: 'end' });
    setMenuIndex(0);
  };

  // Info: (20261118 - Luphia) 編輯框自動調整高度並放好游標
  useLayoutEffect(() => {
    if (!editing) caretPlaced.current = '';
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
    if (editing && caretPlaced.current !== editing.id) {
      caretPlaced.current = editing.id;
      el.focus();
      const pos = editing.caret === 'start' ? 0 : el.value.length;
      el.setSelectionRange(pos, pos);
    }
    if (pendingCaret && appliedCaret.current !== pendingCaret.token) {
      appliedCaret.current = pendingCaret.token;
      el.focus();
      el.setSelectionRange(pendingCaret.pos, pendingCaret.pos);
    }
  });

  const editingKind = editing ? kindOfText(editing.draft.trim()) : null;
  const slashQuery = editing && /^\/[^\s/]*$/.test(editing.draft) ? editing.draft.slice(1).toLowerCase() : null;
  const menuItems = slashQuery === null ? [] : INSERT_ITEMS.filter(item => !slashQuery || item.keywords.includes(slashQuery) || item.label.toLowerCase().includes(slashQuery));

  // Info: (20261118 - Luphia) 數學式 / 圖表即時預覽
  const draftText = editing?.draft ?? '';
  useEffect(() => {
    if (editingKind !== 'math') return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await renderMathPreview(mathBody(draftText));
      if (!cancelled) setMathPreview(result);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editingKind, draftText]);
  useEffect(() => {
    if (editingKind !== 'mermaid') return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const code = mermaidBody(draftText);
      if (!code.trim()) return;
      const result = await renderDiagram(code, settings);
      if (!cancelled) setMermaidPreview(result.ok ? { svg: result.svg, error: null } : { svg: '', error: result.error });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editingKind, draftText, settings]);

  const insertItem = (item: IInsertItem) => {
    if (!editing) return;
    if (item.id === 'image') {
      setImagePicker(true);
      setEditing({ ...editing, draft: '' });
      return;
    }
    setEditing({ ...editing, draft: item.template });
    setPendingCaret({ pos: item.caret ?? item.template.length, token: (pendingCaret?.token ?? 0) + 1 });
  };

  const insertAtCaret = (text: string) => {
    if (!editing) return;
    let [start, end] = selection;
    // Info: (20261118 - Luphia) 游標在 $$ 外面時改插在數學式內 (結尾的 $$ 之前)
    const open = editing.draft.indexOf('$$');
    const close = editing.draft.lastIndexOf('$$');
    if (open >= 0 && close > open) {
      const inner = editing.draft.slice(0, close).replace(/\n$/, '').length;
      if (start > inner || start < open + 2) start = end = inner;
    }
    const draft = editing.draft.slice(0, start) + text + editing.draft.slice(end);
    setEditing({ ...editing, draft });
    const brace = text.indexOf('{}');
    setPendingCaret({ pos: start + (brace >= 0 ? brace + 1 : text.length), token: (pendingCaret?.token ?? 0) + 1 });
  };

  const neighbour = (id: string, delta: number) => {
    const index = blocks.findIndex(b => b.id === id);
    return blocks[index + delta]?.id ?? null;
  };

  const onTextareaKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!editing) return;
    const el = e.currentTarget;
    if (menuItems.length > 0 && !imagePicker) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex(i => (i + (e.key === 'ArrowDown' ? 1 : menuItems.length - 1)) % menuItems.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        insertItem(menuItems[Math.min(menuIndex, menuItems.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setEditing({ ...editing, draft: '' });
        return;
      }
    }
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's'))) {
      e.preventDefault();
      commitEditing();
      return;
    }
    if (editing.id === NEW_BLOCK) return;
    // Info: (20261118 - Luphia) 在第一行按上 / 最後一行按下：移到上一段 / 下一段
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
      const prev = neighbour(editing.id, -1);
      if (prev) {
        e.preventDefault();
        startEditing(prev, 'end');
      }
      return;
    }
    if (e.key === 'ArrowDown' && el.selectionStart === el.value.length) {
      const next = neighbour(editing.id, 1);
      if (next) {
        e.preventDefault();
        startEditing(next, 'start');
      }
    }
  };

  const changeSettings = async (patch: Partial<IDocSettings>) => {
    if (!canEditAll) {
      onToast('Only the document owner can change the PDF settings.', 'info');
      return;
    }
    const next = splitFrontMatter(writeDocSettings(joinFrontMatter(front, ''), { ...settings, ...patch })).front;
    if (doc) setOptimisticFront({ front: next, rev: doc.rev });
    const result = await act({ action: 'front', front: next });
    if (!result.ok) {
      setOptimisticFront(null);
      onToast(result.message, 'error');
    }
  };

  const imageFiles = useMemo(() => resolver.filenames.filter(name => IMAGE_KINDS.has(getFileKind(name))), [resolver.filenames]);

  const pickImage = (target: string) => {
    if (!editing) return;
    const alt = (target.split('/').pop() || 'image').replace(/\.[^.]+$/, '');
    setEditing({ ...editing, draft: `![${alt}](${relativePath(dirOf(filename), target).replace(/ /g, '%20')})` });
    setImagePicker(false);
  };

  const counts = useMemo(
    () => ({ equations: blocks.filter(b => b.text.startsWith('$$')).length, diagrams: blocks.filter(b => /^```mermaid/i.test(b.text)).length }),
    [blocks]
  );

  const downloadPdf = async () => {
    if (!doc) return;
    if (editing) await commitEditing();
    setPdfState('building');
    try {
      const { html, title } = await renderDocumentHtml(source, settings, assets, filename.replace(/\.(md|markdown)$/i, ''));
      const pdf = await requestPdf(roomId, password, html, title);
      const pdfName = pdfNameFor(filename);
      if (!pdf) {
        printDocument(html, MARGIN_SIZES[settings.margins]);
        onToast('This server cannot create PDF files directly. In the print window, choose “Save as PDF”.', 'info');
        return;
      }
      const url = URL.createObjectURL(pdf);
      const a = document.createElement('a');
      a.href = url;
      a.download = pdfName.split('/').pop() || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
      if (alsoToRoom) {
        setPdfState('uploading');
        onUploadPdf(new File([pdf], a.download, { type: 'application/pdf' }), pdfName);
        onToast(`${a.download} downloaded and is being added to the room`, 'success');
      } else {
        onToast(`${a.download} downloaded`, 'success');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'The PDF could not be created', 'error');
    } finally {
      setPdfState('idle');
    }
  };

  const run = async (body: Record<string, unknown>, success?: string) => {
    setBusy(true);
    const result = await act(body);
    setBusy(false);
    if (!result.ok) onToast(result.message, 'error');
    else if (success) onToast(success, 'success');
    return result.ok;
  };

  const openComments = (blockId: string | null) => {
    setPanel('comments');
    setCommentTarget(blockId);
    setDrawerOpen(true);
  };

  const scrollToBlock = (id: string) => {
    document.getElementById(`dh-block-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setDrawerOpen(false);
  };

  const applyMarkdown = async () => {
    if (markdownDraft === null) return;
    if (markdownDraft === source) {
      setMarkdownDraft(null);
      return;
    }
    if (await run({ action: 'reset', source: markdownDraft }, 'Markdown applied')) setMarkdownDraft(null);
  };

  if (status === 'missing') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="rounded-xl border border-white/10 bg-slate-900 px-5 py-4 text-sm text-slate-300">This document is no longer in the room.</p>
        <button type="button" onClick={onClose} className="h-10 rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5">
          Back to room
        </button>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-300">{error}</p>
        <button type="button" onClick={onClose} className="h-10 rounded-xl border border-white/10 px-4 text-sm font-semibold text-slate-200 hover:bg-white/5">
          Back to room
        </button>
      </div>
    );
  }
  if (!doc || !me) {
    return <div className="flex flex-1 items-center justify-center font-mono text-sm text-slate-400 animate-pulse">Opening document…</div>;
  }

  const saving = doc.rev > doc.savedRev;
  const saveLabel = saveError
    ? { text: saveError, tone: 'text-red-300' }
    : saving
      ? { text: 'Saving to room…', tone: 'text-blue-300' }
      : { text: `Saved to room · ${formatAgo(doc.savedAt, now)}`, tone: 'text-emerald-300' };

  const viewers = doc.viewers.filter((v, i, list) => list.findIndex(o => o.id === v.id) === i);
  const openThreads = doc.comments.filter(c => !c.resolved);
  const commentCount = (blockId: string) => doc.comments.filter(c => c.blockId === blockId && !c.resolved).length;
  const doneCount = sections.filter(s => doc.sections[s.id]?.status === 'done').length;
  const people = (() => {
    const list = new Map<string, { id: string; name: string; memberId: string | null }>();
    doc.members.forEach(m => list.set(m.id, { id: m.id, name: m.id === me.id ? `${m.name} (you)` : m.name, memberId: m.memberId }));
    Object.entries(doc.people).forEach(([id, name]) => {
      if (!list.has(id)) list.set(id, { id, name, memberId: null });
    });
    return [...list.values()];
  })();
  const nameOf = (person: IDocPerson | null | undefined) => (person ? (person.id === me.id ? 'You' : person.name) : '');
  const banner =
    !me.canWrite
      ? 'Only the room owner can change files here. You can read, comment and download a PDF.'
      : access === 'assignees' && !me.manager && !Object.values(doc.sections).some(s => s.assignee?.id === me.id)
        ? 'Each section can only be edited by the person assigned to it. You can still read, comment and download a PDF.'
        : null;
  const othersEditing = Object.values(doc.locks).filter(l => l.memberId !== me.memberId);

  const inputBase = 'h-10 rounded-[9px] border border-white/10 bg-slate-900 px-2.5 text-[13px] text-slate-100 outline-none focus:border-blue-500';

  const pdfPanel = (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-slate-400">
        {PAPER_LABELS[settings.paper]} · {counts.equations} {counts.equations === 1 ? 'equation' : 'equations'} · {counts.diagrams}{' '}
        {counts.diagrams === 1 ? 'diagram' : 'diagrams'}
        {!canEditAll && ' · settings are chosen by the document owner'}
      </p>
      <fieldset disabled={!canEditAll}>
        <legend className="mb-2 text-xs font-semibold text-slate-300">Theme</legend>
        <div className="grid grid-cols-4 gap-1.5">
          {(Object.keys(DOC_THEMES) as TDocTheme[]).map(key => (
            <label key={key} className={`flex cursor-pointer flex-col items-center gap-1 text-[11px] ${settings.theme === key ? 'text-slate-100' : 'text-slate-400'}`}>
              <input type="radio" name="doc-theme" aria-label={`${DOC_THEMES[key].label} theme`} value={key} checked={settings.theme === key} onChange={() => changeSettings({ theme: key })} className="peer sr-only" />
              <span
                aria-hidden="true"
                className={`h-11 w-11 rounded-[10px] peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 ${settings.theme === key ? 'ring-2 ring-slate-100 ring-offset-2 ring-offset-[#0B1222]' : ''}`}
                style={{ background: DOC_THEMES[key].accent }}
              />
              {DOC_THEMES[key].label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={!canEditAll}>
        <legend className="mb-2 text-xs font-semibold text-slate-300">Style</legend>
        <div className="flex flex-col gap-1.5">
          {(Object.keys(DOC_STYLES) as TDocStyle[]).map(key => (
            <label
              key={key}
              className={`flex cursor-pointer items-center gap-3 rounded-[10px] border p-2.5 ${settings.style === key ? 'border-blue-500 bg-[#0B1530]' : 'border-white/10 hover:bg-white/5'}`}
            >
              <input type="radio" name="doc-style" aria-label={DOC_STYLES[key].label} checked={settings.style === key} onChange={() => changeSettings({ style: key })} className="sr-only" />
              <StyleThumb style={key} accent={DOC_THEMES[settings.theme].accent} soft={DOC_THEMES[settings.theme].soft} />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-slate-100">{DOC_STYLES[key].label}</span>
                <span className="block text-[11px] leading-4 text-slate-400">{DOC_STYLES[key].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={!canEditAll}>
        <legend className="mb-2 text-xs font-semibold text-slate-300">Paper</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {(['a4', 'letter'] as const).map(paper => (
            <label
              key={paper}
              className={`flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border text-[13px] ${settings.paper === paper ? 'border-blue-500 bg-[#0B1530] text-white' : 'border-white/10 text-slate-300'}`}
            >
              <input type="radio" name="doc-paper" aria-label={PAPER_LABELS[paper]} checked={settings.paper === paper} onChange={() => changeSettings({ paper })} className="accent-blue-500" />
              {PAPER_LABELS[paper]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-slate-300">
          Typeface
          <select disabled={!canEditAll} value={settings.font} onChange={e => changeSettings({ font: e.target.value as IDocSettings['font'] })} className={inputBase}>
            <option value="serif">Serif</option>
            <option value="sans">Sans</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-slate-300">
          Margins
          <select disabled={!canEditAll} value={settings.margins} onChange={e => changeSettings({ margins: e.target.value as IDocSettings['margins'] })} className={inputBase}>
            <option value="normal">Normal</option>
            <option value="narrow">Narrow</option>
          </select>
        </label>
      </div>
      <div className="flex flex-col">
        {(
          [
            ['equationNumbers', 'Number equations'],
            ['toc', 'Table of contents'],
            ['titlePage', 'Title page'],
          ] as [keyof IDocSettings, string][]
        ).map(([key, label]) => (
          <label key={key} className="flex min-h-10 cursor-pointer items-center gap-2.5 text-[13px] text-slate-200">
            <input
              type="checkbox"
              aria-label={label}
              disabled={!canEditAll}
              checked={settings[key] as boolean}
              onChange={e => changeSettings({ [key]: e.target.checked })}
              className="h-[18px] w-[18px] accent-blue-500"
            />
            {label}
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={downloadPdf}
        disabled={pdfState !== 'idle'}
        className="h-12 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500 disabled:cursor-wait disabled:opacity-70"
      >
        {pdfState === 'building' ? 'Building PDF…' : pdfState === 'uploading' ? 'Adding to room…' : 'Download PDF'}
      </button>
      <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-[13px] text-slate-200">
        <input type="checkbox" aria-label="Also add the PDF to this room" checked={alsoToRoom} onChange={e => setAlsoToRoom(e.target.checked)} className="h-[18px] w-[18px] accent-blue-500" />
        Also add the PDF to this room
      </label>
    </div>
  );

  const sectionsPanel = (
    <div className="flex flex-col gap-4">
      <div>
        <p className="flex items-baseline justify-between text-[13px] text-slate-200">
          <span>
            <strong className="text-white">{doneCount}</strong> of {sections.length} sections done
          </span>
          <span className="text-xs text-slate-400">{sections.length ? Math.round((doneCount / sections.length) * 100) : 0}%</span>
        </p>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
          {(['done', 'review', 'writing'] as TSectionStatus[]).map(statusKey => {
            const n = sections.filter(s => (doc.sections[s.id]?.status ?? 'todo') === statusKey).length;
            return n ? <span key={statusKey} className={STATUS_DOTS[statusKey]} style={{ width: `${(n / sections.length) * 100}%` }} /> : null;
          })}
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
          {(['todo', 'writing', 'review', 'done'] as TSectionStatus[]).map(statusKey => (
            <span key={statusKey} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_DOTS[statusKey]}`} />
              {STATUS_LABELS[statusKey]} {sections.filter(s => (doc.sections[s.id]?.status ?? 'todo') === statusKey).length}
            </span>
          ))}
        </p>
      </div>
      {me.manager && (
        <fieldset className="rounded-xl border border-white/10 p-3">
          <legend className="px-1 text-xs font-semibold text-slate-300">Who can edit</legend>
          {(
            [
              ['everyone', 'Everyone in the room', 'Anyone who can add files here can edit any part.'],
              ['assignees', 'Only the assigned person', 'Each section can only be edited by its assignee (and you).'],
            ] as [TDocAccess, string, string][]
          ).map(([value, label, hint]) => (
            <label key={value} className="flex cursor-pointer items-start gap-2.5 py-1.5 text-[13px] text-slate-200">
              <input type="radio" name="doc-access" aria-label={label} checked={access === value} onChange={() => run({ action: 'access', access: value })} className="mt-1 accent-blue-500" />
              <span>
                {label}
                <span className="block text-[11px] text-slate-400">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {sections.length === 0 ? (
        <p className="text-[13px] leading-6 text-slate-400">Add sections with “## Heading” to split the work. Each section can have its own person and progress.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {sections.map((section, i) => {
            const meta = doc.sections[section.id] ?? { assignee: null, status: 'todo' as TSectionStatus };
            const lock = Object.entries(doc.locks).find(([id, l]) => sectionOfBlock[id] === section.id && l.memberId !== me.memberId)?.[1];
            return (
              <li key={section.id} className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
                <button type="button" onClick={() => scrollToBlock(section.id)} className="flex w-full items-start gap-2 text-left text-[13px] font-semibold text-slate-100 hover:text-white">
                  <span className="font-mono text-[11px] text-slate-400">{i + 1}</span>
                  <span className="min-w-0 flex-1">{section.title}</span>
                </button>
                {lock && <p className="mt-1 text-[11px] text-blue-300">{lock.name} is writing here now</p>}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                    Assigned to
                    <select
                      aria-label={`Assignee for ${section.title}`}
                      disabled={!canAssign}
                      value={meta.assignee?.id ?? ''}
                      onFocus={refreshMembers}
                      onChange={e => {
                        const person = people.find(p => p.id === e.target.value);
                        run({ action: 'assign', sectionId: section.id, assignee: person ? (person.memberId ? { memberId: person.memberId } : { id: person.id }) : null });
                      }}
                      className="h-9 rounded-lg border border-white/10 bg-slate-950 px-2 text-[12px] text-slate-100 disabled:opacity-70"
                    >
                      <option value="">Unassigned</option>
                      {meta.assignee && !people.some(p => p.id === meta.assignee?.id) && <option value={meta.assignee.id}>{meta.assignee.name}</option>}
                      {people.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                    Status
                    <select
                      aria-label={`Status of ${section.title}`}
                      disabled={!canSetStatus(section.id)}
                      value={meta.status}
                      onChange={e => run({ action: 'status', sectionId: section.id, status: e.target.value })}
                      className="h-9 rounded-lg border border-white/10 bg-slate-950 px-2 text-[12px] text-slate-100 disabled:opacity-70"
                    >
                      {(Object.keys(STATUS_LABELS) as TSectionStatus[]).map(key => (
                        <option key={key} value={key}>
                          {STATUS_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );

  const visibleComments = doc.comments.filter(c => (showResolved ? c.resolved : !c.resolved) && (!commentTarget || c.blockId === commentTarget));
  const targetBlock = commentTarget ? blocks.find(b => b.id === commentTarget) : null;
  const commentsPanel = (
    <div className="flex flex-col gap-3">
      {commentTarget && (
        <form
          onSubmit={async e => {
            e.preventDefault();
            if (!commentDraft.trim()) return;
            if (await run({ action: 'comment', id: commentTarget, text: commentDraft })) setCommentDraft('');
          }}
          className="flex flex-col gap-2 rounded-xl border border-blue-500/40 bg-[#0B1530] p-3"
        >
          <p className="text-[11px] text-slate-400">
            Comment on: <span className="text-slate-200">{snippet(targetBlock?.text ?? '', 70) || 'a removed part'}</span>
          </p>
          <label htmlFor="dh-comment" className="sr-only">
            New comment
          </label>
          <textarea
            id="dh-comment"
            aria-label="New comment"
            rows={3}
            value={commentDraft}
            onChange={e => setCommentDraft(e.target.value)}
            placeholder="Ask a question or suggest a change"
            className="resize-none rounded-lg border border-white/10 bg-slate-950 p-2 text-[13px] text-slate-100 outline-none focus:border-blue-500"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCommentTarget(null)} className="h-9 rounded-lg px-3 text-xs text-slate-300 hover:bg-white/5">
              Show all
            </button>
            <button type="submit" disabled={busy || !commentDraft.trim()} className="h-9 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60">
              Comment
            </button>
          </div>
        </form>
      )}
      <div role="group" aria-label="Filter comments" className="inline-flex gap-[3px] self-start rounded-[10px] border border-white/10 bg-slate-900 p-[3px]">
        <button type="button" aria-pressed={!showResolved} onClick={() => setShowResolved(false)} className={`h-8 rounded-[7px] px-3 text-xs ${!showResolved ? 'bg-slate-800 font-semibold text-white' : 'text-slate-400'}`}>
          Open {openThreads.length}
        </button>
        <button type="button" aria-pressed={showResolved} onClick={() => setShowResolved(true)} className={`h-8 rounded-[7px] px-3 text-xs ${showResolved ? 'bg-slate-800 font-semibold text-white' : 'text-slate-400'}`}>
          Resolved {doc.comments.length - openThreads.length}
        </button>
      </div>
      {visibleComments.length === 0 && (
        <p className="text-[13px] leading-6 text-slate-400">{commentTarget ? 'No comments on this part yet.' : 'No comments yet. Use the speech bubble beside any part of the page to start a discussion.'}</p>
      )}
      {visibleComments
        .slice()
        .reverse()
        .map(comment => {
          const exists = blocks.some(b => b.id === comment.blockId);
          return (
            <article key={comment.id} aria-label={`Comment by ${nameOf(comment.by)}`} className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
              <button
                type="button"
                onClick={() => exists && scrollToBlock(comment.blockId)}
                className="mb-2 block w-full truncate rounded-md border-l-2 border-slate-500 pl-2 text-left text-[11px] text-slate-400 hover:text-slate-200"
              >
                {exists ? snippet(blocks.find(b => b.id === comment.blockId)?.text ?? comment.quote, 70) : `Removed part: ${snippet(comment.quote, 60)}`}
              </button>
              <p className="flex items-center gap-2 text-[12px]">
                <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: colorOf(comment.by.id) }}>
                  {initialsOf(comment.by.name)}
                </span>
                <span className="font-semibold text-slate-100">{nameOf(comment.by)}</span>
                <span className="text-slate-500">{formatAgo(comment.at, now)}</span>
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-6 text-slate-200">{comment.text}</p>
              {comment.replies.map(reply => (
                <div key={reply.id} className="mt-2 border-l border-white/10 pl-3">
                  <p className="text-[11px]">
                    <span className="font-semibold text-slate-200">{nameOf(reply.by)}</span> <span className="text-slate-500">{formatAgo(reply.at, now)}</span>
                  </p>
                  <p className="whitespace-pre-wrap text-[13px] leading-6 text-slate-300">{reply.text}</p>
                </div>
              ))}
              <form
                className="mt-2 flex gap-2"
                onSubmit={async e => {
                  e.preventDefault();
                  const text = replyDrafts[comment.id]?.trim();
                  if (!text) return;
                  if (await run({ action: 'reply', commentId: comment.id, text })) setReplyDrafts(prev => ({ ...prev, [comment.id]: '' }));
                }}
              >
                <input
                  aria-label={`Reply to ${nameOf(comment.by)}`}
                  value={replyDrafts[comment.id] ?? ''}
                  onChange={e => setReplyDrafts(prev => ({ ...prev, [comment.id]: e.target.value }))}
                  placeholder="Reply"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-2 text-[13px] text-slate-100 outline-none focus:border-blue-500"
                />
                <button type="submit" className="h-9 rounded-lg border border-white/10 px-3 text-xs text-slate-200 hover:bg-white/5">
                  Send
                </button>
              </form>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => run({ action: 'resolve', commentId: comment.id, resolved: !comment.resolved })}
                  className="h-8 rounded-lg bg-slate-800 px-3 text-xs font-semibold text-white hover:bg-slate-700"
                >
                  {comment.resolved ? 'Reopen' : 'Resolve'}
                </button>
                {(comment.by.id === me.id || me.manager) && (
                  <button type="button" onClick={() => run({ action: 'delete-comment', commentId: comment.id })} className="h-8 rounded-lg px-3 text-xs text-red-300 hover:bg-red-500/10">
                    Delete
                  </button>
                )}
              </div>
            </article>
          );
        })}
    </div>
  );

  const historyPanel = (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-slate-400">
        Latest {doc.history.length} of {doc.historyTotal} changes. Restoring adds a new change, so nothing is lost.
      </p>
      {doc.history.length === 0 && <p className="text-[13px] text-slate-400">No changes yet.</p>}
      {doc.history
        .slice()
        .reverse()
        .map(entry => {
          const exists = entry.blockId ? blocks.some(b => b.id === entry.blockId) : false;
          const restoreLabel = entry.kind === 'insert' ? 'Undo' : entry.kind === 'settings' || entry.kind === 'rewrite' ? 'Restore before' : 'Restore previous';
          return (
            <article key={entry.id} aria-label={`${nameOf(entry.by)} ${HISTORY_LABELS[entry.kind]}`} className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
              <p className="flex items-center gap-2 text-[12px]">
                <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: colorOf(entry.by.id) }}>
                  {initialsOf(entry.by.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold text-slate-100">{nameOf(entry.by)}</span> <span className="text-slate-300">{HISTORY_LABELS[entry.kind]}</span>
                </span>
                <span className="shrink-0 text-slate-500">{formatAgo(entry.at, now)}</span>
              </p>
              {(entry.kind === 'edit' || entry.kind === 'restore') && entry.before !== null && (
                <p className="mt-1.5 text-[12px] leading-5 text-red-300 line-through decoration-red-400/60">{snippet(entry.before)}</p>
              )}
              {entry.kind === 'delete' && <p className="mt-1.5 text-[12px] leading-5 text-red-300 line-through decoration-red-400/60">{snippet(entry.before)}</p>}
              {(entry.kind === 'edit' || entry.kind === 'insert' || entry.kind === 'restore') && entry.after !== null && entry.blockId && (
                <p className="mt-1 text-[12px] leading-5 text-emerald-300">{snippet(entry.after)}</p>
              )}
              <div className="mt-2 flex gap-2">
                {exists && (
                  <button type="button" onClick={() => entry.blockId && scrollToBlock(entry.blockId)} className="h-8 rounded-lg px-3 text-xs text-slate-300 hover:bg-white/5">
                    Show
                  </button>
                )}
                {me.canWrite && entry.kind !== 'restore' && (
                  <button type="button" disabled={busy} onClick={() => run({ action: 'restore', historyId: entry.id }, 'Restored')} className="h-8 rounded-lg bg-slate-800 px-3 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-60">
                    {restoreLabel}
                  </button>
                )}
              </div>
            </article>
          );
        })}
    </div>
  );

  const tabs: [TPanel, string][] = [
    ['sections', 'Sections'],
    ['comments', `Comments${openThreads.length ? ` ${openThreads.length}` : ''}`],
    ['history', 'History'],
    ['pdf', 'PDF'],
  ];
  const panelBody = (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Document panel" className="grid grid-cols-4 gap-[3px] rounded-[10px] border border-white/10 bg-slate-900 p-[3px]">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={panel === key}
            onClick={() => setPanel(key)}
            className={`h-9 rounded-[7px] text-[12px] ${panel === key ? 'bg-slate-800 font-semibold text-white' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{panel === 'sections' ? sectionsPanel : panel === 'comments' ? commentsPanel : panel === 'history' ? historyPanel : pdfPanel}</div>
    </div>
  );

  const renderEditing = () => {
    if (!editing) return null;
    const kind = editingKind;
    return (
      <div className="dh-editing relative my-2">
        <label htmlFor="dh-block-editor" className="sr-only">
          Edit (Markdown)
        </label>
        <textarea
          id="dh-block-editor"
          aria-label="Edit (Markdown)"
          ref={textareaRef}
          value={editing.draft}
          spellCheck={kind !== 'math' && kind !== 'mermaid' && kind !== 'code'}
          onChange={e => {
            setEditing({ ...editing, draft: e.target.value });
            setSelection([e.target.selectionStart, e.target.selectionEnd]);
          }}
          onSelect={e => setSelection([e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
          onKeyDown={onTextareaKey}
          placeholder="Write Markdown, or type / to insert"
          rows={1}
          className={`block w-full resize-none overflow-hidden rounded-lg border-2 bg-slate-50 px-3 py-2 font-mono text-[13.5px] leading-6 text-slate-800 outline-none placeholder:text-slate-400 ${kind === 'math' ? 'border-fuchsia-500 text-fuchsia-900' : kind === 'mermaid' ? 'border-emerald-600 text-emerald-900' : 'border-blue-500'}`}
        />
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-sans text-[11px] text-slate-500">
          <span>{kind === 'math' ? 'Equation · LaTeX (KaTeX)' : kind === 'mermaid' ? 'Mermaid diagram' : 'Markdown'} · others see this part as locked · Esc to finish</span>
          <button type="button" onClick={commitEditing} className="h-8 rounded-md bg-slate-800 px-3 text-[12px] font-semibold text-white hover:bg-slate-700">
            Done
          </button>
        </div>

        {kind === 'math' && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 font-sans">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Insert math">
              {MATH_SNIPPETS.map(item => (
                <button
                  key={item.aria}
                  type="button"
                  aria-label={item.aria}
                  title={item.tex}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => insertAtCaret(item.tex)}
                  className="h-8 min-w-9 rounded-md border border-slate-200 px-2 font-serif text-[13px] italic text-slate-700 hover:bg-slate-100"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="mt-2 min-h-12 overflow-x-auto" aria-live="polite">
              {mathPreview?.error ? <p className="text-[12px] text-red-700">{mathPreview.error}</p> : mathPreview ? <div dangerouslySetInnerHTML={{ __html: mathPreview.html }} /> : null}
            </div>
          </div>
        )}

        {kind === 'mermaid' && (
          <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 font-sans">
            <p className={`text-[11px] font-semibold ${mermaidPreview?.error ? 'text-red-700' : 'text-emerald-700'}`} aria-live="polite">
              {mermaidPreview?.error ? `Error · ${mermaidPreview.error.split('\n')[0]}` : mermaidPreview ? 'Valid · updates live' : 'Drawing…'}
            </p>
            {mermaidPreview?.svg && <div className="dh-mermaid mt-2" dangerouslySetInnerHTML={{ __html: mermaidPreview.svg }} />}
          </div>
        )}

        {menuItems.length > 0 && !imagePicker && (
          <div role="listbox" aria-label="Insert" className="absolute left-0 top-full z-20 mt-1 flex w-72 flex-col gap-0.5 rounded-xl border border-white/10 bg-slate-900 p-1.5 font-sans text-slate-100 shadow-2xl">
            {menuItems.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={i === Math.min(menuIndex, menuItems.length - 1)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => insertItem(item)}
                className={`flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${i === Math.min(menuIndex, menuItems.length - 1) ? 'bg-slate-800' : 'hover:bg-slate-800/60'}`}
              >
                <span className="flex-1">{item.label}</span>
                <span className="font-mono text-[11px] text-slate-400">{item.hint}</span>
              </button>
            ))}
            <span className="px-2.5 pb-1 pt-1.5 text-[11px] text-slate-400">↑↓ to choose · Enter to insert · Esc to close</span>
          </div>
        )}

        {imagePicker && (
          <div className="absolute left-0 top-full z-20 mt-1 flex max-h-72 w-80 flex-col gap-0.5 overflow-y-auto rounded-xl border border-white/10 bg-slate-900 p-1.5 font-sans text-slate-100 shadow-2xl">
            <p className="px-2.5 py-1.5 text-[11px] font-semibold text-slate-400">Images in this room</p>
            {imageFiles.length === 0 ? (
              <p className="px-2.5 pb-2 text-[12px] text-slate-400">No images yet. Upload one to the room first.</p>
            ) : (
              imageFiles.map(name => (
                <button key={name} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pickImage(name)} className="min-h-10 truncate rounded-lg px-2.5 text-left text-[13px] hover:bg-slate-800">
                  {name}
                </button>
              ))
            )}
            <button type="button" onClick={() => setImagePicker(false)} className="min-h-9 rounded-lg px-2.5 text-left text-[12px] text-slate-400 hover:bg-slate-800">
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col 2xl:flex-row" data-doc-editor>
      {/* eslint-disable-next-line @next/next/no-css-tags -- KaTeX 樣式 (含字型) 放在 public/vendor/katex */}
      <link rel="stylesheet" href="/vendor/katex/katex.min.css" precedence="default" />
      <style>{docCss(settings)}</style>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-white/10 px-2 py-2 sm:gap-3 sm:px-4 lg:px-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back to room"
            className="inline-flex h-10 min-w-10 items-center justify-center rounded-lg px-2 text-[13px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <span aria-hidden="true">←</span>
            <span className="ml-1 hidden sm:inline">Back to room</span>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-bold text-slate-100 sm:text-[16px]" title={filename}>
              {filename}
            </h1>
            <p className={`truncate text-[11px] ${saveLabel.tone}`} aria-live="polite">
              {saveLabel.text}
            </p>
          </div>
          <ul aria-label={`${viewers.length} ${viewers.length === 1 ? 'person' : 'people'} in this document`} className="hidden items-center sm:flex">
            {viewers.slice(0, 5).map(v => (
              <li
                key={v.id}
                title={v.id === me.id ? `${v.name} (you)` : v.name}
                className="-ml-1.5 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#020617] text-[11px] font-bold text-white first:ml-0"
                style={{ background: colorOf(v.id) }}
              >
                {initialsOf(v.name)}
              </li>
            ))}
            {viewers.length > 5 && <li className="-ml-1.5 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#020617] bg-slate-700 text-[11px] text-white">+{viewers.length - 5}</li>}
          </ul>
          <button
            type="button"
            aria-pressed={markdownDraft !== null}
            onClick={async () => {
              if (markdownDraft !== null) {
                setMarkdownDraft(null);
                return;
              }
              if (editing) await commitEditing();
              setMarkdownDraft(source);
            }}
            className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] border px-3 text-xs font-semibold ${markdownDraft !== null ? 'border-blue-500 bg-[#0B1530] text-white' : 'border-white/10 text-slate-200 hover:bg-white/5'}`}
          >
            <span className="font-mono" aria-hidden="true">
              M↓
            </span>
            <span className="sr-only sm:not-sr-only">{markdownDraft !== null ? 'Show page' : 'Show Markdown'}</span>
          </button>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="relative h-10 shrink-0 rounded-[10px] bg-blue-600 px-3.5 text-xs font-semibold text-white hover:bg-blue-500 2xl:hidden"
          >
            Team &amp; PDF
            {openThreads.length > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-900">{openThreads.length}</span>
            )}
          </button>
        </header>

        {banner && <div className="border-b border-white/10 bg-slate-900 px-4 py-2.5 text-[13px] text-slate-300 lg:px-6">{banner}</div>}
        {othersEditing.length > 0 && (
          <div className="border-b border-white/10 bg-[#0B1530] px-4 py-2 text-[12px] text-blue-100 lg:px-6" aria-live="polite">
            {[...new Set(othersEditing.map(l => l.name))].join(', ')} {othersEditing.length === 1 ? 'is' : 'are'} editing now — their parts are locked until they finish.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#0B1222] px-3 py-4 lg:px-6 lg:py-8">
          {markdownDraft !== null ? (
            <div className="mx-auto flex max-w-[794px] flex-col gap-3">
              <label htmlFor="dh-source" className="sr-only">
                Markdown source
              </label>
              <textarea
                id="dh-source"
                aria-label="Markdown source"
                value={markdownDraft}
                readOnly={!canEditAll}
                onChange={e => setMarkdownDraft(e.target.value)}
                spellCheck={false}
                className="block min-h-[65vh] w-full resize-y rounded-lg border border-white/10 bg-slate-950 p-4 font-mono text-[13.5px] leading-6 text-slate-200 outline-none focus:border-blue-500"
              />
              <div className="flex flex-wrap items-center justify-end gap-2">
                {canEditAll ? (
                  <>
                    <span className="mr-auto text-[12px] text-slate-400">
                      {othersEditing.length ? 'Applying waits until others finish their edits.' : 'Applying replaces the whole document for everyone (it can be restored from History).'}
                    </span>
                    <button type="button" onClick={() => setMarkdownDraft(null)} className="h-10 rounded-xl border border-white/10 px-4 text-[13px] font-semibold text-slate-300 hover:bg-white/5">
                      Discard
                    </button>
                    <button
                      type="button"
                      disabled={busy || markdownDraft === source}
                      onClick={applyMarkdown}
                      className="h-10 rounded-xl bg-blue-600 px-4 text-[13px] font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                    >
                      Apply Markdown
                    </button>
                  </>
                ) : (
                  <span className="text-[12px] text-slate-400">Read only: only the document owner can rewrite the whole document.</span>
                )}
              </div>
            </div>
          ) : (
            <article
              aria-label="Document page"
              className="dh-doc mx-auto min-h-[60vh] rounded-[4px] bg-white px-5 py-6 shadow-[0_10px_30px_rgba(0,0,0,0.5)] sm:p-[var(--dh-margin)]"
              style={{ maxWidth: PAPER_WIDTHS[settings.paper], ['--dh-margin' as string]: MARGIN_SIZES[settings.margins] }}
            >
              {blocks.map(block => {
                const isEditing = editing?.id === block.id;
                const lock = lockedByOther(block.id);
                const editable = canEditBlock(block.id) && !lock;
                const isSection = headingDepth(block.text) === 2;
                const sectionMeta = isSection ? (doc.sections[block.id] ?? { assignee: null, status: 'todo' as TSectionStatus }) : null;
                const comments = commentCount(block.id);
                const html = rendered[block.text]?.html;
                return (
                  <div key={block.id} id={`dh-block-${block.id}`} className="group/block relative">
                    {sectionMeta && (
                      <div className="dh-section-bar mb-[-6px] mt-6 flex flex-wrap items-center gap-2 font-sans text-[11px]">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${STATUS_TONES[sectionMeta.status]}`}>
                          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATUS_DOTS[sectionMeta.status]}`} />
                          {STATUS_LABELS[sectionMeta.status]}
                        </span>
                        {sectionMeta.assignee ? (
                          <span className="inline-flex items-center gap-1 text-slate-600">
                            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: colorOf(sectionMeta.assignee.id) }}>
                              {initialsOf(sectionMeta.assignee.name)}
                            </span>
                            {nameOf(sectionMeta.assignee)}
                          </span>
                        ) : (
                          <span className="text-slate-500">Unassigned</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setPanel('sections');
                            setDrawerOpen(true);
                          }}
                          className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                        >
                          {canAssign ? 'Assign…' : 'Details'}
                        </button>
                      </div>
                    )}
                    {isEditing ? (
                      renderEditing()
                    ) : (
                      <div
                        className={`dh-block relative rounded-md ${editable ? 'cursor-text outline-offset-4 hover:outline hover:outline-1 hover:outline-slate-200' : ''}`}
                        style={lock ? { outline: `2px solid ${colorOf(lock.memberId)}`, outlineOffset: 4 } : undefined}
                        data-kind={kindOfText(block.text)}
                        onClick={e => {
                          // Info: (20261118 - Luphia) 被鎖住或沒有權限時也回應，告訴對方原因
                          if (!me.canWrite) return;
                          if ((e.target as HTMLElement).closest('a')) e.preventDefault();
                          startEditing(block.id);
                        }}
                        onKeyDown={e => {
                          if (editable && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                            e.preventDefault();
                            startEditing(block.id);
                          }
                        }}
                        role={editable ? 'button' : undefined}
                        tabIndex={editable ? 0 : undefined}
                        aria-label={editable ? `Edit ${kindOfText(block.text)}` : undefined}
                      >
                        {html !== undefined ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="whitespace-pre-wrap font-mono text-[13px] text-slate-400">{block.text}</pre>}
                        {lock && (
                          <span
                            className="absolute -top-3 right-0 rounded-full px-2 py-0.5 font-sans text-[11px] font-semibold text-white shadow"
                            style={{ background: colorOf(lock.memberId) }}
                          >
                            {lock.name} is editing
                          </span>
                        )}
                      </div>
                    )}
                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => openComments(block.id)}
                        aria-label={comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'} on this part` : 'Comment on this part'}
                        className={`absolute -top-4 right-0 flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-1.5 font-sans text-[11px] font-semibold transition-opacity sm:-right-4 sm:top-0 sm:translate-x-full ${comments ? 'bg-amber-100 text-amber-900 opacity-100' : 'bg-slate-100 text-slate-500 opacity-0 focus:opacity-100 group-hover/block:opacity-100 pointer-coarse:opacity-60'}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
                        </svg>
                        {comments > 0 && comments}
                      </button>
                    )}
                  </div>
                );
              })}
              {editing?.id === NEW_BLOCK && renderEditing()}
              {editing?.id !== NEW_BLOCK && (canEditAll || (blocks.length > 0 && canEditBlock(blocks[blocks.length - 1].id))) && (
                <button
                  type="button"
                  onClick={startNew}
                  className="mt-4 block w-full rounded-lg border border-dashed border-slate-300 px-4 py-3 text-left font-sans text-[13px] text-slate-500 hover:border-slate-400 hover:text-slate-700"
                >
                  {blocks.length === 0 ? 'Start writing — type / to insert an equation, diagram or table' : 'Add a paragraph, or type / to insert'}
                </button>
              )}
            </article>
          )}
        </div>
      </div>

      {/* Info: (20261118 - Luphia) 寬螢幕：右側面板；其他：由右側 / 下方滑出 */}
      <aside aria-label="Team and PDF" className="hidden w-[340px] shrink-0 overflow-y-auto border-l border-white/10 bg-[#0B1222] p-5 2xl:block">
        {panelBody}
      </aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-end 2xl:hidden">
          <button type="button" aria-label="Close panel" onClick={() => setDrawerOpen(false)} className="absolute inset-0 bg-black/70" />
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Team and PDF"
            className="relative max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border-t border-white/10 bg-[#0B1222] p-4 pb-6 sm:h-full sm:max-h-none sm:w-[380px] sm:rounded-none sm:border-l sm:border-t-0"
          >
            <div className="mb-2 flex justify-end">
              <button type="button" onClick={() => setDrawerOpen(false)} className="h-10 rounded-lg px-3 text-[13px] text-slate-300 hover:bg-white/5">
                Close
              </button>
            </div>
            {panelBody}
          </section>
        </div>
      )}
    </div>
  );
}
