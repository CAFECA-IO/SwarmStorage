/**
 * Info: (20261105 - Luphia)
 * HTML 文件安全預覽
 * - 文件以 <iframe sandbox srcdoc> 呈現，永不加上 allow-same-origin，因此與 DropHere 主站隔離 (opaque origin)
 * - 注入 Content-Security-Policy：預設封鎖腳本、外部資源、表單與內嵌框架
 * - 注入一段帶 nonce 的輔助腳本，負責目錄跳轉、頁內搜尋、列印與開啟房間內其他檔案
 * - 文件中引用的房間檔案 (圖片、CSS、腳本) 可轉為內嵌資料，連到房間內檔案的超連結改由主頁面開啟
 */

export const PREVIEW_MESSAGE_SOURCE = 'drophere-preview';

// Info: (20261105 - Luphia) sandbox 屬性：允許腳本 (輔助腳本需要；文件腳本由 CSP 控制)、彈出新分頁、列印對話框
export const PREVIEW_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals';

const MAX_INLINE_ASSET_BYTES = 20 * 1024 * 1024;

export interface IHtmlPreviewOptions {
  allowScripts: boolean;
  allowExternal: boolean;
  resolveRoomFiles: boolean;
}

export interface IHtmlOutlineItem {
  id: string;
  text: string;
  level: number;
}

export interface IRoomFileResolver {
  // Info: (20261105 - Luphia) 房間內所有檔名
  filenames: string[];
  // Info: (20261105 - Luphia) 取得房間檔案內容
  load: (filename: string) => Promise<Blob>;
  // Info: (20261105 - Luphia) 取得房間檔案大小 (bytes)，用於限制內嵌大小
  sizeOf: (filename: string) => number;
}

export interface IPreparedHtml {
  srcDoc: string;
  title: string;
  outline: IHtmlOutlineItem[];
  // Info: (20261105 - Luphia) 已內嵌的房間檔案
  inlinedFiles: string[];
  // Info: (20261105 - Luphia) 已移除的腳本數量 (腳本關閉時)
  removedScripts: number;
}

export type TPreviewMessage =
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'open'; filename: string }
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'activeHeading'; id: string }
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'findResult'; found: boolean; index: number; total: number };

export type TPreviewCommand =
  | { type: 'scrollTo'; id: string }
  | { type: 'find'; query: string; backwards?: boolean }
  | { type: 'print' };

export const isPreviewMessage = (data: unknown): data is TPreviewMessage =>
  typeof data === 'object' && data !== null && (data as { source?: unknown }).source === PREVIEW_MESSAGE_SOURCE;

const createNonce = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, '');
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const dirOf = (filename?: string) => (filename && filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : '');

// Info: (20261108 - Luphia) 依所在資料夾解析相對路徑 (支援 ./ 與 ../，不可超出房間根目錄)
const resolveRelative = (baseDir: string, ref: string): string | null => {
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of ref.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
};

/**
 * Info: (20261105 - Luphia)
 * 判斷引用是否指向房間內檔案：只接受相對路徑
 * Info: (20261108 - Luphia) 依引用文件所在的資料夾解析 (資料夾上傳的網站可完整預覽)；
 * 房間根目錄的文件仍可只以檔名比對 (相容沒有資料夾的舊房間)
 */
const matchRoomFile = (ref: string | null, roomFiles: Set<string>, baseDir = ''): string | null => {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }
  let pathPart = trimmed.split(/[?#]/)[0];
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    // Info: (20261105 - Luphia) 保留原字串
  }
  const resolved = resolveRelative(baseDir, pathPart);
  if (resolved && roomFiles.has(resolved)) return resolved;
  const basename = pathPart.split('/').pop() || '';
  return !baseDir && roomFiles.has(basename) ? basename : null;
};

const buildCsp = (options: IHtmlPreviewOptions, nonce: string): string => {
  const remote = options.allowExternal ? ' https: http:' : '';
  const scriptSrc = options.allowScripts ? `'unsafe-inline'${remote}` : `'nonce-${nonce}'`;
  const connectSrc = options.allowScripts && options.allowExternal ? 'https: http:' : "'none'";
  return [
    "default-src 'none'",
    `img-src data: blob:${remote}`,
    `media-src data: blob:${remote}`,
    `font-src data:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `script-src ${scriptSrc}`,
    `connect-src ${connectSrc}`,
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
};

/**
 * Info: (20261105 - Luphia)
 * 注入預覽頁面的輔助腳本 (在 sandbox 內執行，只能透過 postMessage 與主頁面溝通)
 */
const HELPER_SCRIPT = `(function () {
  var S = '${PREVIEW_MESSAGE_SOURCE}';
  function post(m) { m.source = S; parent.postMessage(m, '*'); }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-dh-open]') : null;
    if (a) { e.preventDefault(); post({ type: 'open', filename: a.getAttribute('data-dh-open') }); }
  }, true);
  var matches = [];
  var cursor = -1;
  var lastQuery = null;
  var canHighlight = !!(window.CSS && CSS.highlights && window.Highlight);
  function collect(query) {
    matches = [];
    if (!query || !document.body) return;
    var needle = query.toLowerCase();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var tag = node.parentNode ? node.parentNode.nodeName : '';
        return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var text = node.nodeValue.toLowerCase();
      var at = text.indexOf(needle);
      while (at !== -1) {
        var range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        matches.push(range);
        at = text.indexOf(needle, at + needle.length);
      }
    }
  }
  function paint() {
    if (canHighlight) {
      var all = new Highlight();
      matches.forEach(function (r) { all.add(r); });
      var current = new Highlight();
      if (cursor >= 0) current.add(matches[cursor]);
      CSS.highlights.set('dh-find', all);
      CSS.highlights.set('dh-find-current', current);
    } else {
      var sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); if (cursor >= 0) sel.addRange(matches[cursor]); }
    }
    if (cursor >= 0) {
      var el = matches[cursor].startContainer.parentElement;
      if (el) el.scrollIntoView({ block: 'center' });
    }
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.source !== S) return;
    if (d.type === 'scrollTo') {
      var target = document.getElementById(d.id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (d.type === 'find') {
      if (d.query !== lastQuery) { lastQuery = d.query; collect(d.query); cursor = -1; }
      if (!matches.length) {
        cursor = -1;
        paint();
        post({ type: 'findResult', found: false, index: 0, total: 0 });
        return;
      }
      cursor = d.backwards ? (cursor <= 0 ? matches.length - 1 : cursor - 1) : (cursor + 1) % matches.length;
      paint();
      post({ type: 'findResult', found: true, index: cursor + 1, total: matches.length });
    } else if (d.type === 'print') {
      window.print();
    }
  });
  var headings = Array.prototype.slice.call(document.querySelectorAll('[data-dh-heading]'));
  var current = '';
  var pending = false;
  function updateActive() {
    pending = false;
    var active = headings.length ? headings[0].id : '';
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= 96) active = headings[i].id; else break;
    }
    if (active && active !== current) { current = active; post({ type: 'activeHeading', id: active }); }
  }
  window.addEventListener('scroll', function () {
    if (!pending) { pending = true; requestAnimationFrame(updateActive); }
  }, { passive: true });
  post({ type: 'ready' });
  updateActive();
})();`;

/**
 * Info: (20261105 - Luphia)
 * 將使用者上傳的 HTML 轉為可安全預覽的 srcdoc
 */
export async function prepareHtmlPreview(
  html: string,
  options: IHtmlPreviewOptions,
  resolver?: IRoomFileResolver,
  currentFilename?: string
): Promise<IPreparedHtml> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nonce = createNonce();
  const roomFiles = new Set(resolver?.filenames.filter(name => name !== currentFilename) ?? []);
  const inlinedFiles = new Set<string>();
  const baseDir = dirOf(currentFilename);

  // Info: (20261105 - Luphia) 移除會改變導覽行為或覆寫安全設定的標籤
  doc.querySelectorAll('meta[http-equiv], base').forEach(el => el.remove());

  // Info: (20261105 - Luphia) 腳本關閉時一併移除 <script>、事件屬性與 javascript: 連結 (CSP 之外的第二層防護)
  let removedScripts = 0;
  if (!options.allowScripts) {
    doc.querySelectorAll('script, noscript').forEach(el => {
      if (el.tagName === 'SCRIPT') removedScripts++;
      el.remove();
    });
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if (/^\s*javascript:/i.test(attr.value) && ['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name)) {
          el.removeAttribute(attr.name);
        }
      }
    });
  }

  // Info: (20261105 - Luphia) 目錄：h1-h3，補上 id
  const outline: IHtmlOutlineItem[] = [];
  doc.querySelectorAll('h1, h2, h3').forEach((el, i) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!el.id) el.id = `dh-heading-${i}`;
    el.setAttribute('data-dh-heading', '');
    outline.push({ id: el.id, text: text.length > 80 ? `${text.slice(0, 77)}…` : text, level: Number(el.tagName[1]) });
  });

  // Info: (20261105 - Luphia) 解析房間內檔案引用
  if (options.resolveRoomFiles && resolver && roomFiles.size > 0) {
    const tasks: Promise<void>[] = [];
    // Info: (20261108 - Luphia) CSS 中的 url() 依 CSS 檔所在資料夾解析並內嵌 (字型、背景圖)
    const inlineCssUrls = async (css: string, cssDir: string): Promise<string> => {
      const refs = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
      const replacements = new Map<string, string>();
      await Promise.all(
        refs.map(async match => {
          const filename = matchRoomFile(match[2], roomFiles, cssDir);
          if (!filename || replacements.has(match[0]) || resolver.sizeOf(filename) > MAX_INLINE_ASSET_BYTES) return;
          try {
            replacements.set(match[0], `url("${await blobToDataUrl(await resolver.load(filename))}")`);
            inlinedFiles.add(filename);
          } catch {
            // Info: (20261108 - Luphia) 保留原本的 url()
          }
        })
      );
      return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, whole => replacements.get(whole) ?? whole);
    };
    const inline = async (filename: string, apply: (blob: Blob) => Promise<void>) => {
      if (resolver.sizeOf(filename) > MAX_INLINE_ASSET_BYTES) return;
      try {
        await apply(await resolver.load(filename));
        inlinedFiles.add(filename);
      } catch (err) {
        console.warn(`[Preview] Failed to inline ${filename}:`, err);
      }
    };

    doc.querySelectorAll<HTMLElement>('img[src], source[src], video[src], audio[src], input[type="image"][src]').forEach(el => {
      const filename = matchRoomFile(el.getAttribute('src'), roomFiles, baseDir);
      if (filename) {
        el.removeAttribute('srcset');
        tasks.push(inline(filename, async blob => el.setAttribute('src', await blobToDataUrl(blob))));
      }
    });
    doc.querySelectorAll<HTMLElement>('video[poster]').forEach(el => {
      const filename = matchRoomFile(el.getAttribute('poster'), roomFiles, baseDir);
      if (filename) tasks.push(inline(filename, async blob => el.setAttribute('poster', await blobToDataUrl(blob))));
    });
    doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]').forEach(el => {
      const filename = matchRoomFile(el.getAttribute('href'), roomFiles, baseDir);
      if (filename) {
        tasks.push(
          inline(filename, async blob => {
            const style = doc.createElement('style');
            style.textContent = await inlineCssUrls(await blob.text(), dirOf(filename));
            el.replaceWith(style);
          })
        );
      }
    });
    if (options.allowScripts) {
      doc.querySelectorAll<HTMLScriptElement>('script[src]').forEach(el => {
        const filename = matchRoomFile(el.getAttribute('src'), roomFiles, baseDir);
        if (filename) {
          tasks.push(
            inline(filename, async blob => {
              el.removeAttribute('src');
              el.textContent = await blob.text();
            })
          );
        }
      });
    }
    // Info: (20261108 - Luphia) 內嵌 <style> 中的 url() (相對於 HTML 文件)
    doc.querySelectorAll<HTMLStyleElement>('style').forEach(el => {
      const css = el.textContent || '';
      if (/url\(/i.test(css)) tasks.push(inlineCssUrls(css, baseDir).then(text => void (el.textContent = text)));
    });
    doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(el => {
      const filename = matchRoomFile(el.getAttribute('href'), roomFiles, baseDir);
      if (filename) {
        el.setAttribute('data-dh-open', filename);
        el.setAttribute('href', '#');
      }
    });
    await Promise.all(tasks);
  }

  // Info: (20261105 - Luphia) 外部連結一律開新分頁
  doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(el => {
    const href = el.getAttribute('href') || '';
    if (el.hasAttribute('data-dh-open') || href.startsWith('#')) return;
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  });

  // Info: (20261105 - Luphia) CSP 必須是 <head> 的第一個元素，才能涵蓋文件中所有資源
  const head = doc.head;
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', buildCsp(options, nonce));
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(charset, csp);

  // Info: (20261105 - Luphia) 頁內搜尋的標示樣式 (CSS Custom Highlight API)
  const findStyle = doc.createElement('style');
  findStyle.textContent =
    '::highlight(dh-find){background-color:#fde68a;color:#111}::highlight(dh-find-current){background-color:#f59e0b;color:#111}';
  head.appendChild(findStyle);

  const helper = doc.createElement('script');
  helper.setAttribute('nonce', nonce);
  helper.textContent = HELPER_SCRIPT;
  (doc.body || doc.documentElement).appendChild(helper);

  return {
    srcDoc: `<!doctype html>\n${doc.documentElement.outerHTML}`,
    title: (doc.title || '').trim(),
    outline,
    inlinedFiles: [...inlinedFiles],
    removedScripts,
  };
}
