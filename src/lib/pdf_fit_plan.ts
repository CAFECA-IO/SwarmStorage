/**
 * Info: (20261120 - Luphia)
 * PDF 符合大小 (壓縮 + 分割) 的共用規劃邏輯 (瀏覽器與伺服器共用，不依賴 Node 模組)
 * - 壓縮只重新取樣影像 (文字、向量不變)；各等級的壓縮比由伺服器抽樣量測
 * - 分割依每頁估計大小貪婪切段；可選擇只在章節 (書籤) 之間切開
 * - 估計值僅供預覽；實際檔案存檔後會再量一次，超過上限的部分再切開
 */

export type TFitLevel = 'none' | 'light' | 'balanced' | 'strong';

export const FIT_LEVEL_ORDER: TFitLevel[] = ['none', 'light', 'balanced', 'strong'];

export const FIT_LEVELS: Record<TFitLevel, { label: string; dpi: number | null; quality: number; hint: string }> = {
  none: { label: 'Off', dpi: null, quality: 0, hint: 'Split only, images unchanged' },
  light: { label: 'Light', dpi: 200, quality: 82, hint: 'Images at 200 dpi' },
  balanced: { label: 'Balanced', dpi: 150, quality: 72, hint: 'Images at 150 dpi · text and vectors untouched' },
  strong: { label: 'Strong', dpi: 96, quality: 60, hint: 'Images at 96 dpi · fine print in scans may blur' },
};

export const MB = 1024 * 1024;
export const MIN_LIMIT_MB = 1;
export const MAX_LIMIT_MB = 2048;
// Info: (20261120 - Luphia) 估計值與實際大小有落差：規劃時只用到上限的 92%
export const PLAN_HEADROOM = 0.92;
// Info: (20261120 - Luphia) 常用上限
export const LIMIT_PRESETS: { mb: number; label: string }[] = [
  { mb: 10, label: '10 MB · email' },
  { mb: 15, label: '15 MB' },
  { mb: 25, label: '25 MB · Gmail' },
  { mb: 50, label: '50 MB' },
];

export interface IPdfChapter {
  title: string;
  // Info: (20261120 - Luphia) 0 起算的頁碼
  page: number;
  level: number;
}

export interface ISharedObject {
  size: number;
  image: boolean;
  // Info: (20261120 - Luphia) 使用此物件的頁面 (連續頁以 [起, 迄] 表示)
  runs: [number, number][];
}

export interface IPdfAnalysis {
  filename: string;
  size: number;
  pages: number;
  // Info: (20261120 - Luphia) 每頁專用物件的大小：可壓縮影像 / 其他 (很小的共用物件依引用頁數攤提)
  pageImage: number[];
  pageOther: number[];
  // Info: (20261120 - Luphia) 多頁共用的物件 (字型、重複的圖片)：每個用到它的檔案都要一份
  shared: ISharedObject[];
  overhead: number;
  images: { count: number; processable: number; bytes: number };
  // Info: (20261120 - Luphia) 各壓縮等級下可壓縮影像的大小比例 (抽樣量測)
  ratios: Record<TFitLevel, number>;
  sampled: number;
  chapters: IPdfChapter[];
  // Info: (20261120 - Luphia) 用來切段的章節起始頁 (不含第 1 頁)
  breaks: number[];
}

export interface IPartPlan {
  from: number;
  to: number;
  estimate: number;
  over: boolean;
}

// Info: (20261120 - Luphia) 每頁用到的共用物件索引 (依分析結果快取)
const sharedIndex = new WeakMap<IPdfAnalysis, number[][]>();
function sharedByPage(a: IPdfAnalysis): number[][] {
  const cached = sharedIndex.get(a);
  if (cached) return cached;
  const byPage: number[][] = Array.from({ length: a.pages }, () => []);
  a.shared.forEach((obj, index) => obj.runs.forEach(([from, to]) => {
    for (let p = from; p <= to && p < a.pages; p++) byPage[p].push(index);
  }));
  sharedIndex.set(a, byPage);
  return byPage;
}

// Info: (20261120 - Luphia) 逐頁累加一段的估計大小 (共用物件只算一次)
class RangeEstimate {
  private total: number;
  private included = new Set<number>();
  constructor(private a: IPdfAnalysis, private ratio: number) {
    this.total = a.overhead;
  }
  add(page: number) {
    this.total += (this.a.pageOther[page] ?? 0) + (this.a.pageImage[page] ?? 0) * this.ratio;
    sharedByPage(this.a)[page]?.forEach(index => {
      if (this.included.has(index)) return;
      this.included.add(index);
      const obj = this.a.shared[index];
      this.total += obj.image ? obj.size * this.ratio : obj.size;
    });
  }
  // Info: (20261120 - Luphia) 加上下一頁後的大小 (不改變目前狀態)
  peek(page: number): number {
    let extra = (this.a.pageOther[page] ?? 0) + (this.a.pageImage[page] ?? 0) * this.ratio;
    sharedByPage(this.a)[page]?.forEach(index => {
      if (this.included.has(index)) return;
      const obj = this.a.shared[index];
      extra += obj.image ? obj.size * this.ratio : obj.size;
    });
    return this.total + extra;
  }
  get value() {
    return Math.round(this.total);
  }
}

export function estimateRange(a: IPdfAnalysis, level: TFitLevel, from: number, to: number): number {
  const acc = new RangeEstimate(a, a.ratios[level] ?? 1);
  for (let p = from; p <= to; p++) acc.add(p);
  return acc.value;
}

export const estimateTotal = (a: IPdfAnalysis, level: TFitLevel) => estimateRange(a, level, 0, a.pages - 1);

/**
 * Info: (20261120 - Luphia)
 * 自動切段：每段盡量放滿 (不超過上限 × 92%)；snap 時切在最後一個放得下的章節起點前
 * 單頁就超過上限時，該頁自成一段並標記 over
 */
export function planParts(a: IPdfAnalysis, level: TFitLevel, limitBytes: number, snap: boolean): IPartPlan[] {
  const target = limitBytes * PLAN_HEADROOM;
  const parts: IPartPlan[] = [];
  if (estimateTotal(a, level) <= target) return [{ from: 0, to: a.pages - 1, estimate: estimateTotal(a, level), over: false }];
  const ratio = a.ratios[level] ?? 1;
  let start = 0;
  while (start < a.pages) {
    const acc = new RangeEstimate(a, ratio);
    acc.add(start);
    let end = start;
    while (end + 1 < a.pages && acc.peek(end + 1) <= target) {
      end += 1;
      acc.add(end);
    }
    if (end + 1 < a.pages && snap) {
      const fitting = a.breaks.filter(b => b > start && b <= end + 1);
      // Info: (20261120 - Luphia) 切在章節前會讓這段不到一半大小時 (例如封面頁)，改為放滿
      const snapped = fitting.length ? fitting[fitting.length - 1] - 1 : end;
      if (snapped < end && estimateRange(a, level, start, snapped) >= acc.value * 0.5) end = snapped;
    }
    const estimate = estimateRange(a, level, start, end);
    parts.push({ from: start, to: end, estimate, over: estimate > limitBytes });
    start = end + 1;
  }
  return parts;
}

// Info: (20261120 - Luphia) 自訂切點：ends 為各段最後一頁 (不含最後一段)
export function partsFromEnds(a: IPdfAnalysis, level: TFitLevel, limitBytes: number, ends: number[]): IPartPlan[] {
  const sorted = [...new Set(ends.filter(e => Number.isInteger(e) && e >= 0 && e < a.pages - 1))].sort((x, y) => x - y);
  const parts: IPartPlan[] = [];
  let start = 0;
  for (const end of [...sorted, a.pages - 1]) {
    const estimate = estimateRange(a, level, start, end);
    parts.push({ from: start, to: end, estimate, over: estimate > limitBytes });
    start = end + 1;
  }
  return parts;
}

export const endsOf = (parts: { to: number }[]) => parts.slice(0, -1).map(p => p.to);

const leafOf = (filename: string) => filename.split('/').pop() || filename;
const dirOf = (filename: string) => (filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/') + 1) : '');
export const baseNameOf = (filename: string) => leafOf(filename).replace(/\.pdf$/i, '') || 'document';

export const formatLimit = (mb: number) => `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;

// Info: (20261120 - Luphia) 結果資料夾：「book (15 MB parts)」，與原檔放在同一層
export const partsFolderFor = (filename: string, limitMb: number) => `${dirOf(filename)}${baseNameOf(filename)} (${formatLimit(limitMb)} parts)`;

// Info: (20261120 - Luphia) 各段檔名 book_01.pdf …；超過 99 段時改用 3 位數
export function partNamesFor(filename: string, count: number): string[] {
  const width = Math.max(2, String(count).length);
  return Array.from({ length: count }, (_, i) => `${baseNameOf(filename)}_${String(i + 1).padStart(width, '0')}.pdf`);
}

// Info: (20261120 - Luphia) 只需壓縮 (一個檔案) 時的檔名，放在原檔旁
export const compressedNameFor = (filename: string) => `${dirOf(filename)}${baseNameOf(filename)} (compressed).pdf`;

// Info: (20261120 - Luphia) 背景工作 (伺服器推送給房間內所有人)
export type TFitJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';
export type TFitStep = 'analyze' | 'compress' | 'split' | 'save';

export interface IFitJobPart {
  filename: string;
  from: number;
  to: number;
  size: number;
  chapters: string | null;
}

export interface IPdfFitJob {
  id: string;
  filename: string;
  limitMb: number;
  level: TFitLevel;
  status: TFitJobStatus;
  step: TFitStep;
  // Info: (20261120 - Luphia) 目前步驟的進度 0–1 與說明
  progress: number;
  detail: string;
  startedBy: { memberId: string; nickname: string };
  startedAt: number;
  finishedAt: number | null;
  pages: number;
  originalSize: number;
  compressedSize: number | null;
  // Info: (20261120 - Luphia) 結果：多個檔案時為資料夾，否則為單一檔案
  folder: string | null;
  parts: IFitJobPart[];
  error: string | null;
}

// Info: (20261120 - Luphia) 大小顯示：接近上限時需要小數 (13.6 MB)
export function formatSize(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / MB;
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// Info: (20261120 - Luphia) 頁碼範圍 (1 起算)
export const pageRange = (from: number, to: number) => (from === to ? `p. ${from + 1}` : `p. ${from + 1}–${to + 1}`);
