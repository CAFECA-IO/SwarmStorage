import { existsSync } from 'fs';
import { chromium, type Browser } from 'playwright-core';

/**
 * Info: (20261118 - Luphia)
 * 伺服器端 PDF 產生：以無頭 Chromium 列印文件 HTML (文字可選取、數學式與圖表為向量)
 * - 使用本機已安裝的 Chrome / Chromium (DOCS_PDF_CHROME 可指定路徑)；找不到時由前端改用瀏覽器列印
 * - 文件 HTML 由瀏覽器端產生、已移除腳本；這裡仍停用 JavaScript 並封鎖所有網路請求 (只允許 data:)
 * - 同時最多 2 份，瀏覽器閒置 5 分鐘後關閉
 */

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 2;
const RENDER_TIMEOUT_MS = 60 * 1000;

const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

let executable: string | null | undefined;

export function findChrome(): string | null {
  if (executable !== undefined) return executable;
  const list = [process.env.DOCS_PDF_CHROME, safeBundledPath(), ...CANDIDATES].filter((p): p is string => !!p);
  executable = list.find(p => existsSync(p)) ?? null;
  return executable;
}

function safeBundledPath(): string | null {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

let browserPromise: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
const waiting: (() => void)[] = [];

const getBrowser = (path: string) => {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        executablePath: path,
        headless: true,
        // Info: (20261118 - Luphia) 以 root 執行 (容器) 時 Chromium 無法使用沙盒
        chromiumSandbox: typeof process.getuid === 'function' ? process.getuid() !== 0 : true,
      })
      .then(browser => {
        browser.on('disconnected', () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch(err => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
};

const scheduleClose = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (running > 0 || !browserPromise) return;
    const closing = browserPromise;
    browserPromise = null;
    closing.then(browser => browser.close()).catch(() => undefined);
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
};

const acquire = () =>
  new Promise<void>(resolve => {
    if (running < MAX_CONCURRENT) {
      running++;
      resolve();
    } else {
      waiting.push(() => {
        running++;
        resolve();
      });
    }
  });
const release = () => {
  running--;
  waiting.shift()?.();
  scheduleClose();
};

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface IPdfRequest {
  html: string;
  title: string;
  pageNumbers: boolean;
  // Info: (20261118 - Luphia) 頁尾左右對齊頁面邊界
  margin: string;
}

export async function renderPdf({ html, title, pageNumbers, margin }: IPdfRequest): Promise<Buffer> {
  const path = findChrome();
  if (!path) throw new Error('unavailable');
  await acquire();
  try {
    const browser = await getBrowser(path);
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    try {
      await context.route('**/*', route => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      const page = await context.newPage();
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      await page.evaluate(() => document.fonts.ready).catch(() => undefined);
      const footer = `<div style="width:100%;padding:0 ${margin};display:flex;justify-content:space-between;font:8px ui-sans-serif,system-ui,sans-serif;color:#6B7280"><span>${escapeHtml(title)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
      return await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: pageNumbers,
        headerTemplate: '<span></span>',
        footerTemplate: pageNumbers ? footer : '<span></span>',
        tagged: true,
        outline: true,
      });
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    release();
  }
}
