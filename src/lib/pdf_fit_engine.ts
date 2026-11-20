import { deflateSync, inflateSync } from 'zlib';
import sharp from 'sharp';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import { FIT_LEVELS, FIT_LEVEL_ORDER, type IPdfAnalysis, type IPdfChapter, type ISharedObject, type TFitLevel } from '@/lib/pdf_fit_plan';

/**
 * Info: (20261120 - Luphia)
 * PDF 壓縮與分割 (伺服器端)：
 * - 分析：每頁大小 (共用物件攤提)、影像、書籤章節；抽樣量測各壓縮等級的影像壓縮比
 * - 壓縮：把影像重新取樣到指定 dpi 並以 JPEG 重新編碼 (變小才替換)；未壓縮的資料流改用 Flate
 *   文字、字型與向量圖不變；遮罩、CMYK、索引色、1 位元掃描等影像維持原樣
 * - 分割：複製頁面到新檔案，保留該段的書籤與段內連結；指向其他段的連結移除
 */

export class FitError extends Error {}

const LOAD_OPTIONS = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false, parseSpeed: 1500 } as const;
// Info: (20261120 - Luphia) 太小的影像不處理 (省下的空間不值得重新編碼)
const MIN_IMAGE_BYTES = 24 * 1024;
const MIN_IMAGE_PIXELS = 96 * 96;
// Info: (20261120 - Luphia) 重新編碼後至少要小 5% 才替換
const KEEP_IF_ABOVE = 0.95;
const SAMPLE_IMAGES = 10;
const OVERHEAD_BYTES = 2048;
// Info: (20261120 - Luphia) 小於此大小的共用物件直接攤提到各頁 (減少傳給瀏覽器的資料)
const SHARED_MIN_BYTES = 2048;
// Info: (20261120 - Luphia) 走訪頁面物件時略過的鍵 (會連到其他頁面或整份文件結構)
const SKIP_KEYS = new Set(['/Parent', '/P', '/Dest', '/A', '/PA', '/Prev', '/Next', '/First', '/Last', '/B', '/StructParent', '/StructParents', '/IRT', '/Popup']);

const N = (name: string) => PDFName.of(name);
const yieldLoop = () => new Promise<void>(resolve => setImmediate(resolve));

type TImageKind = 'dct' | 'flate' | 'raw';

interface IImageInfo {
  ref: PDFRef;
  width: number;
  height: number;
  bytes: number;
  kind: TImageKind | null;
  channels: number;
  // Info: (20261120 - Luphia) 出現頁面中最大的長邊 (英吋)：取樣上限 = dpi × 長邊
  maxInches: number;
}

export interface ILoadedPdf {
  doc: PDFDocument;
  analysis: IPdfAnalysis;
  images: Map<string, IImageInfo>;
  // Info: (20261120 - Luphia) 每頁用到的可壓縮影像 (預覽比較用)
  pageImages: string[][];
}

// --- Info: (20261120 - Luphia) 影像解碼與重新編碼 ---

const filtersOf = (dict: PDFDict): string[] => {
  const filter = dict.lookup(N('Filter'));
  if (filter instanceof PDFName) return [filter.asString()];
  if (filter instanceof PDFArray) return filter.asArray().map(f => (f instanceof PDFName ? f.asString() : '?'));
  return [];
};

const numberOf = (dict: PDFDict, key: string): number | null => {
  const value = dict.lookup(N(key));
  return value instanceof PDFNumber ? value.asNumber() : null;
};

// Info: (20261120 - Luphia) 色彩空間的色版數 (只處理灰階與 RGB；其他回傳 0)
function componentsOf(dict: PDFDict): number {
  const cs = dict.lookup(N('ColorSpace'));
  if (cs instanceof PDFName) {
    const name = cs.asString();
    if (name === '/DeviceRGB' || name === '/CalRGB') return 3;
    if (name === '/DeviceGray' || name === '/CalGray') return 1;
    return 0;
  }
  if (cs instanceof PDFArray) {
    const family = cs.lookup(0);
    const name = family instanceof PDFName ? family.asString() : '';
    if (name === '/CalRGB') return 3;
    if (name === '/CalGray') return 1;
    if (name === '/ICCBased') {
      const profile = cs.lookup(1);
      const n = profile instanceof PDFStream ? numberOf(profile.dict, 'N') : null;
      return n === 3 || n === 1 ? n : 0;
    }
  }
  return 0;
}

function classifyImage(stream: PDFRawStream, masks: Set<string>, tag: string): Pick<IImageInfo, 'width' | 'height' | 'kind' | 'channels'> {
  const dict = stream.dict;
  const width = numberOf(dict, 'Width') ?? 0;
  const height = numberOf(dict, 'Height') ?? 0;
  const base = { width, height, kind: null, channels: 0 };
  if (masks.has(tag) || width * height < MIN_IMAGE_PIXELS || stream.contents.length < MIN_IMAGE_BYTES) return base;
  const imageMask = dict.lookup(N('ImageMask'));
  if (imageMask && imageMask.toString() === 'true') return base;
  if (dict.has(N('Decode')) || dict.lookup(N('Mask')) instanceof PDFArray) return base;
  const channels = componentsOf(dict);
  if (!channels) return base;
  const filters = filtersOf(dict);
  if (filters.length === 1 && filters[0] === '/DCTDecode') return { width, height, kind: 'dct', channels };
  if ((numberOf(dict, 'BitsPerComponent') ?? 8) !== 8) return base;
  if (filters.length === 1 && filters[0] === '/FlateDecode') {
    const params = dict.lookup(N('DecodeParms'));
    const predictor = params instanceof PDFDict ? (numberOf(params, 'Predictor') ?? 1) : 1;
    if (predictor !== 1 && predictor < 10) return base;
    return { width, height, kind: 'flate', channels };
  }
  if (filters.length === 0) return { width, height, kind: 'raw', channels };
  return base;
}

// Info: (20261120 - Luphia) PNG 預測器還原 (FlateDecode Predictor ≥ 10)
function unpredict(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r > 0 ? out[dst - rowBytes + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let value = raw;
      if (type === 1) value = raw + left;
      else if (type === 2) value = raw + up;
      else if (type === 3) value = raw + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[dst + i] = value & 0xff;
    }
  }
  return out;
}

interface IDecoded {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function decodeImage(stream: PDFRawStream, info: IImageInfo): Promise<IDecoded | null> {
  try {
    if (info.kind === 'dct') {
      const { data, info: meta } = await sharp(stream.contents, { failOn: 'none' }).raw().toBuffer({ resolveWithObject: true });
      if (meta.channels !== 1 && meta.channels !== 3) return null;
      return { data, width: meta.width, height: meta.height, channels: meta.channels };
    }
    let pixels: Uint8Array = info.kind === 'flate' ? inflateSync(stream.contents) : stream.contents;
    const params = stream.dict.lookup(N('DecodeParms'));
    const predictor = params instanceof PDFDict ? (numberOf(params, 'Predictor') ?? 1) : 1;
    if (predictor >= 10) pixels = unpredict(pixels, info.width * info.channels, info.channels);
    const expected = info.width * info.height * info.channels;
    if (pixels.length < expected) return null;
    return { data: Buffer.from(pixels.buffer, pixels.byteOffset, expected), width: info.width, height: info.height, channels: info.channels };
  } catch {
    return null;
  }
}

function targetSize(info: IImageInfo, level: TFitLevel): { width: number; height: number } {
  const dpi = FIT_LEVELS[level].dpi;
  if (!dpi) return { width: info.width, height: info.height };
  const maxLong = Math.ceil(dpi * info.maxInches);
  const scale = Math.min(1, maxLong / Math.max(info.width, info.height));
  return { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) };
}

async function encodeImage(decoded: IDecoded, info: IImageInfo, level: TFitLevel): Promise<{ bytes: Buffer; width: number; height: number }> {
  const size = targetSize(info, level);
  let pipeline = sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels as 1 | 3 } });
  if (size.width !== decoded.width || size.height !== decoded.height) pipeline = pipeline.resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' });
  if (decoded.channels === 1) pipeline = pipeline.toColourspace('b-w');
  const bytes = await pipeline.jpeg({ quality: FIT_LEVELS[level].quality, chromaSubsampling: '4:2:0' }).toBuffer();
  return { bytes, ...size };
}

// --- Info: (20261120 - Luphia) 文件結構 ---

const refTag = (ref: PDFRef) => ref.toString();

function textOf(value: PDFObject | undefined): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText().replace(/\s+/g, ' ').trim();
  return '';
}

// Info: (20261120 - Luphia) 具名目的地 (Catalog /Dests 或 Names /Dests 名稱樹)
function namedDestination(doc: PDFDocument, name: string): PDFArray | null {
  const ctx = doc.context;
  const unwrap = (value: PDFObject | undefined): PDFArray | null => {
    const resolved = value instanceof PDFRef ? ctx.lookup(value) : value;
    if (resolved instanceof PDFArray) return resolved;
    if (resolved instanceof PDFDict) {
      const d = resolved.lookup(N('D'));
      return d instanceof PDFArray ? d : null;
    }
    return null;
  };
  const dests = doc.catalog.lookup(N('Dests'));
  if (dests instanceof PDFDict) {
    const found = unwrap(dests.get(N(name)));
    if (found) return found;
  }
  const names = doc.catalog.lookup(N('Names'));
  const tree = names instanceof PDFDict ? names.lookup(N('Dests')) : undefined;
  const search = (node: PDFObject | undefined, depth: number): PDFArray | null => {
    if (!(node instanceof PDFDict) || depth > 20) return null;
    const pairs = node.lookup(N('Names'));
    if (pairs instanceof PDFArray) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) {
        if (textOf(pairs.lookup(i)) === name) return unwrap(pairs.get(i + 1));
      }
    }
    const kids = node.lookup(N('Kids'));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const found = search(kids.lookup(i), depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return search(tree, 0);
}

// Info: (20261120 - Luphia) 書籤或連結的目的地 → 頁碼 (0 起算) 與目的地陣列
function resolveDestination(doc: PDFDocument, holder: PDFDict, pageIndex: Map<string, number>): { page: number; dest: PDFArray } | null {
  let dest: PDFObject | undefined = holder.lookup(N('Dest'));
  if (!dest) {
    const action = holder.lookup(N('A'));
    if (action instanceof PDFDict) {
      const kind = action.lookup(N('S'));
      if (kind instanceof PDFName && kind.asString() === '/GoTo') dest = action.lookup(N('D'));
    }
  }
  if (dest instanceof PDFName) dest = namedDestination(doc, dest.decodeText()) ?? undefined;
  else if (dest instanceof PDFString || dest instanceof PDFHexString) dest = namedDestination(doc, dest.decodeText()) ?? undefined;
  if (!(dest instanceof PDFArray) || dest.size() === 0) return null;
  const target = dest.get(0);
  if (!(target instanceof PDFRef)) return null;
  const page = pageIndex.get(refTag(target));
  return page === undefined ? null : { page, dest };
}

// Info: (20261120 - Luphia) 書籤 (前兩層)
function readChapters(doc: PDFDocument, pageIndex: Map<string, number>): IPdfChapter[] {
  const chapters: IPdfChapter[] = [];
  const outlines = doc.catalog.lookup(N('Outlines'));
  if (!(outlines instanceof PDFDict)) return chapters;
  const visit = (first: PDFObject | undefined, level: number) => {
    let item = first instanceof PDFDict ? first : undefined;
    for (let guard = 0; item && guard < 2000; guard++) {
      const resolved = resolveDestination(doc, item, pageIndex);
      const title = textOf(item.lookup(N('Title')));
      if (resolved && title) chapters.push({ title: title.slice(0, 120), page: resolved.page, level });
      if (level === 0) visit(item.lookup(N('First')), 1);
      const next = item.lookup(N('Next'));
      item = next instanceof PDFDict ? next : undefined;
    }
  };
  visit(outlines.lookup(N('First')), 0);
  return chapters;
}

// Info: (20261120 - Luphia) 切段用的章節起點：第一層書籤；只有一個第一層 (書名) 時改用第二層
function breaksOf(chapters: IPdfChapter[]): number[] {
  const top = chapters.filter(c => c.level === 0);
  const chosen = top.length < 2 ? chapters.filter(c => c.level === 1) : top;
  return [...new Set(chosen.map(c => c.page).filter(p => p > 0))].sort((a, b) => a - b);
}

interface IWeights {
  pageImage: number[];
  pageOther: number[];
  shared: ISharedObject[];
  images: Map<string, IImageInfo>;
  pageImages: string[][];
}

/**
 * Info: (20261120 - Luphia)
 * 每頁可到達的物件與大小：只被一頁使用的物件算在該頁，多頁共用的依頁數攤提
 */
async function measurePages(doc: PDFDocument): Promise<IWeights> {
  const ctx = doc.context;
  const pages = doc.getPages();
  const longest = Math.max(1, ...pages.map(p => Math.max(...Object.values(p.getSize())) / 72));
  const masks = new Set<string>();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const ref = obj.dict.get(N(key));
      if (ref instanceof PDFRef) masks.add(refTag(ref));
    }
  }
  const sizes = new Map<string, number>();
  const usage = new Map<string, number>();
  const images = new Map<string, IImageInfo>();
  const reached: string[][] = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const inches = Math.max(...Object.values(page.getSize())) / 72;
    const seen = new Set<string>();
    const stack: PDFObject[] = [page.node];
    const resources = page.node.getInheritableAttribute(N('Resources'));
    if (resources) stack.push(resources);
    while (stack.length) {
      const obj = stack.pop() as PDFObject;
      if (obj instanceof PDFRef) {
        const tag = refTag(obj);
        if (seen.has(tag)) continue;
        seen.add(tag);
        const target = ctx.lookup(obj);
        if (!target) continue;
        if (!sizes.has(tag)) sizes.set(tag, target.sizeInBytes());
        if (target instanceof PDFRawStream) {
          const subtype = target.dict.get(N('Subtype'));
          if (subtype instanceof PDFName && subtype.asString() === '/Image') {
            const known = images.get(tag);
            if (known) known.maxInches = Math.max(known.maxInches, inches);
            else images.set(tag, { ref: obj, bytes: target.contents.length, maxInches: inches, ...classifyImage(target, masks, tag) });
          }
        }
        stack.push(target);
      } else if (obj instanceof PDFDict) {
        for (const [key, value] of obj.entries()) if (!SKIP_KEYS.has(key.asString())) stack.push(value);
      } else if (obj instanceof PDFArray) {
        stack.push(...obj.asArray());
      } else if (obj instanceof PDFStream) {
        stack.push(obj.dict);
      }
    }
    seen.forEach(tag => usage.set(tag, (usage.get(tag) ?? 0) + 1));
    reached.push([...seen]);
    if (i % 25 === 24) await yieldLoop();
  }
  // Info: (20261120 - Luphia) 不在任何頁面上的影像 (例如只在表單中)：以最大頁面估計
  images.forEach(info => {
    if (!info.maxInches) info.maxInches = longest;
  });

  const pageImage = reached.map(() => 0);
  const pageOther = reached.map(() => 0);
  const pageImages: string[][] = reached.map(() => []);
  const sharedPages = new Map<string, number[]>();
  reached.forEach((tags, i) => {
    tags.forEach(tag => {
      const size = sizes.get(tag) ?? 0;
      const count = usage.get(tag) ?? 1;
      const compressible = !!images.get(tag)?.kind;
      if (compressible) pageImages[i].push(tag);
      // Info: (20261120 - Luphia) 多頁共用且夠大的物件另外記錄；其餘依引用頁數攤提到各頁
      if (count > 1 && size >= SHARED_MIN_BYTES) {
        const list = sharedPages.get(tag) ?? [];
        list.push(i);
        sharedPages.set(tag, list);
      } else if (compressible) pageImage[i] += size / count;
      else pageOther[i] += size / count;
    });
  });
  const shared: ISharedObject[] = [...sharedPages.entries()].map(([tag, list]) => {
    const runs: [number, number][] = [];
    list.forEach(p => {
      const last = runs[runs.length - 1];
      if (last && last[1] === p - 1) last[1] = p;
      else runs.push([p, p]);
    });
    return { size: sizes.get(tag) ?? 0, image: !!images.get(tag)?.kind, runs };
  });
  return { pageImage, pageOther, shared, images, pageImages };
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  } catch {
    throw new FitError('This file could not be read as a PDF');
  }
  if (doc.isEncrypted) throw new FitError('Password-protected PDFs can’t be compressed or split');
  if (doc.getPageCount() === 0) throw new FitError('This PDF has no pages');
  return doc;
}

/**
 * Info: (20261120 - Luphia)
 * 分析：頁面大小、影像與章節；抽樣 (最多 10 張，從大到小平均挑選) 量測各等級的壓縮比
 */
export async function analyzePdf(bytes: Uint8Array, filename: string, onProgress?: (fraction: number) => void): Promise<ILoadedPdf> {
  const doc = await loadPdf(bytes);
  onProgress?.(0.3);
  const weights = await measurePages(doc);
  onProgress?.(0.5);
  const pageIndex = new Map(doc.getPages().map((p, i) => [refTag(p.ref), i] as const));
  const chapters = readChapters(doc, pageIndex);

  const processable = [...weights.images.values()].filter(img => img.kind).sort((a, b) => b.bytes - a.bytes);
  const count = Math.min(SAMPLE_IMAGES, processable.length);
  const sample = Array.from({ length: count }, (_, i) => processable[count === 1 ? 0 : Math.round((i * (processable.length - 1)) / (count - 1))]);
  const totals: Record<TFitLevel, number> = { none: 0, light: 0, balanced: 0, strong: 0 };
  let original = 0;
  for (let i = 0; i < sample.length; i++) {
    const info = sample[i];
    const stream = doc.context.lookup(info.ref);
    const decoded = stream instanceof PDFRawStream ? await decodeImage(stream, info) : null;
    original += info.bytes;
    for (const level of FIT_LEVEL_ORDER) {
      if (level === 'none' || !decoded) {
        totals[level] += info.bytes;
        continue;
      }
      const encoded = await encodeImage(decoded, info, level);
      totals[level] += encoded.bytes.length < info.bytes * KEEP_IF_ABOVE ? encoded.bytes.length : info.bytes;
    }
    onProgress?.(0.5 + (0.5 * (i + 1)) / sample.length);
  }
  const ratios = Object.fromEntries(FIT_LEVEL_ORDER.map(level => [level, original ? totals[level] / original : 1])) as Record<TFitLevel, number>;

  const analysis: IPdfAnalysis = {
    filename,
    size: bytes.length,
    pages: doc.getPageCount(),
    pageImage: weights.pageImage.map(Math.round),
    pageOther: weights.pageOther.map(Math.round),
    shared: weights.shared,
    overhead: OVERHEAD_BYTES,
    images: {
      count: weights.images.size,
      processable: processable.length,
      bytes: [...weights.images.values()].reduce((sum, img) => sum + img.bytes, 0),
    },
    ratios,
    sampled: sample.length,
    chapters,
    breaks: breaksOf(chapters),
  };
  return { doc, analysis, images: weights.images, pageImages: weights.pageImages };
}

// Info: (20261120 - Luphia) 壓縮後重新量測每頁大小 (切段用)
export async function measureCompressed(doc: PDFDocument, base: IPdfAnalysis): Promise<IPdfAnalysis> {
  const weights = await measurePages(doc);
  const ones = Object.fromEntries(FIT_LEVEL_ORDER.map(level => [level, 1])) as Record<TFitLevel, number>;
  return {
    ...base,
    pageImage: weights.pageImage.map(Math.round),
    pageOther: weights.pageOther.map(Math.round),
    shared: weights.shared,
    ratios: ones,
  };
}

/**
 * Info: (20261120 - Luphia)
 * 壓縮 (直接修改 doc)：逐張影像重新取樣、重新編碼；未壓縮的資料流改用 Flate
 */
export async function compressPdf(
  doc: PDFDocument,
  level: TFitLevel,
  onProgress: (done: number, total: number) => void,
  shouldStop: () => boolean
): Promise<{ replaced: number }> {
  const ctx = doc.context;
  let replaced = 0;
  if (level !== 'none') {
    const weights = await measurePages(doc);
    const list = [...weights.images.values()].filter(img => img.kind);
    for (let i = 0; i < list.length; i++) {
      if (shouldStop()) return { replaced };
      const info = list[i];
      const stream = ctx.lookup(info.ref);
      if (stream instanceof PDFRawStream) {
        const decoded = await decodeImage(stream, info);
        if (decoded) {
          const encoded = await encodeImage(decoded, info, level);
          if (encoded.bytes.length < info.bytes * KEEP_IF_ABOVE) {
            const dict = stream.dict.clone(ctx);
            dict.set(N('Filter'), N('DCTDecode'));
            dict.set(N('Width'), PDFNumber.of(encoded.width));
            dict.set(N('Height'), PDFNumber.of(encoded.height));
            dict.set(N('BitsPerComponent'), PDFNumber.of(8));
            dict.delete(N('DecodeParms'));
            dict.delete(N('Length'));
            ctx.assign(info.ref, PDFRawStream.of(dict, new Uint8Array(encoded.bytes)));
            replaced += 1;
          }
        }
      }
      onProgress(i + 1, list.length);
      await yieldLoop();
    }
  }
  // Info: (20261120 - Luphia) 沒有壓縮的資料流 (內容、字型等) 改用 Flate (XML metadata 維持原樣)
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 1024 || obj.dict.has(N('Filter'))) continue;
    const type = obj.dict.get(N('Type'));
    if (type instanceof PDFName && type.asString() === '/Metadata') continue;
    const packed = deflateSync(obj.contents, { level: 6 });
    if (packed.length >= obj.contents.length * KEEP_IF_ABOVE) continue;
    const dict = obj.dict.clone(ctx);
    dict.set(N('Filter'), N('FlateDecode'));
    dict.delete(N('Length'));
    ctx.assign(ref, PDFRawStream.of(dict, new Uint8Array(packed)));
  }
  return { replaced };
}

/**
 * Info: (20261120 - Luphia)
 * 分割前整理 (直接修改 doc)：連結的目的地改為頁碼 (避免複製頁面時把目標頁面一起帶進去)、
 * 移除註解的 /P 與頁面的文章串 /B
 */
export function prepareForSplit(doc: PDFDocument) {
  const pages = doc.getPages();
  const pageIndex = new Map(pages.map((p, i) => [refTag(p.ref), i] as const));
  pages.forEach(page => {
    page.node.delete(N('B'));
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      annot.delete(N('P'));
      const subtype = annot.get(N('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.asString() !== '/Link') continue;
      const action = annot.lookup(N('A'));
      const kind = action instanceof PDFDict ? action.lookup(N('S')) : undefined;
      const isGoTo = !action || (kind instanceof PDFName && kind.asString() === '/GoTo');
      if (!isGoTo) continue;
      const resolved = resolveDestination(doc, annot, pageIndex);
      annot.delete(N('A'));
      annot.delete(N('Dest'));
      if (resolved) annot.set(N('Dest'), doc.context.obj([PDFNumber.of(resolved.page), ...resolved.dest.asArray().slice(1)]));
    }
  });
}

function addOutline(out: PDFDocument, items: IPdfChapter[], pageRefs: PDFRef[]) {
  if (items.length === 0) return;
  const ctx = out.context;
  const outlinesRef = ctx.nextRef();
  // Info: (20261120 - Luphia) 第二層項目掛在前一個第一層項目下；前面沒有第一層時升為第一層
  const top: { item: IPdfChapter; ref: PDFRef; children: { item: IPdfChapter; ref: PDFRef }[] }[] = [];
  items.forEach(item => {
    const entry = { item, ref: ctx.nextRef() };
    const parent = top[top.length - 1];
    if (item.level > 0 && parent && parent.item.level === 0) parent.children.push(entry);
    else top.push({ ...entry, children: [] });
  });
  const write = (list: { item: IPdfChapter; ref: PDFRef }[], parent: PDFRef) => {
    list.forEach((entry, i) => {
      const dict = ctx.obj({
        Title: PDFHexString.fromText(entry.item.title),
        Parent: parent,
        Dest: [pageRefs[entry.item.page], 'Fit'],
      });
      if (i > 0) dict.set(N('Prev'), list[i - 1].ref);
      if (i < list.length - 1) dict.set(N('Next'), list[i + 1].ref);
      ctx.assign(entry.ref, dict);
    });
  };
  write(top, outlinesRef);
  top.forEach(entry => {
    if (!entry.children.length) return;
    write(entry.children, entry.ref);
    const dict = ctx.lookup(entry.ref) as PDFDict;
    dict.set(N('First'), entry.children[0].ref);
    dict.set(N('Last'), entry.children[entry.children.length - 1].ref);
    dict.set(N('Count'), PDFNumber.of(-entry.children.length));
  });
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: top[0].ref, Last: top[top.length - 1].ref, Count: top.length }));
  out.catalog.set(N('Outlines'), outlinesRef);
  out.catalog.set(N('PageMode'), N('UseOutlines'));
}

/**
 * Info: (20261120 - Luphia)
 * 產生一段 (from–to，0 起算)：複製頁面、段內連結指向新頁面 (段外的移除)、加上該段的書籤
 * 需先呼叫 prepareForSplit
 */
export async function buildPart(src: PDFDocument, from: number, to: number, chapters: IPdfChapter[], title: string): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const indices = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const copied = await out.copyPages(src, indices);
  copied.forEach(page => out.addPage(page));
  const refs = out.getPages().map(p => p.ref);
  out.getPages().forEach(page => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      const dest = annot.lookup(N('Dest'));
      if (!(dest instanceof PDFArray) || !(dest.get(0) instanceof PDFNumber)) continue;
      const target = (dest.get(0) as PDFNumber).asNumber();
      if (target >= from && target <= to) dest.set(0, refs[target - from]);
      else annots.remove(i);
    }
  });
  addOutline(
    out,
    chapters.filter(c => c.page >= from && c.page <= to).map(c => ({ ...c, page: c.page - from })),
    refs
  );
  out.setTitle(title);
  out.setProducer('Drop Here');
  return out.save({ useObjectStreams: true, objectsPerTick: 200 });
}

/**
 * Info: (20261120 - Luphia)
 * 預覽比較：取該頁最大的可壓縮影像，比較原圖與壓縮後同一區域 (原始像素 1:1 的中央區塊)
 */
export async function sampleCompare(loaded: ILoadedPdf, page: number, level: TFitLevel) {
  const tags = loaded.pageImages[page] ?? [];
  const infos = tags.map(tag => loaded.images.get(tag)).filter((x): x is IImageInfo => !!x?.kind);
  if (infos.length === 0) return null;
  const info = infos.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const stream = loaded.doc.context.lookup(info.ref);
  const decoded = stream instanceof PDFRawStream ? await decodeImage(stream, info) : null;
  if (!decoded) return null;
  const side = Math.min(decoded.width, decoded.height, 560);
  const left = Math.floor((decoded.width - side) / 2);
  const top = Math.floor((decoded.height - side) / 2);
  const raw = { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels as 1 | 3 } };
  const original = await sharp(decoded.data, raw).extract({ left, top, width: side, height: side }).jpeg({ quality: 92 }).toBuffer();

  let compressedBytes = info.bytes;
  let size = { width: info.width, height: info.height };
  let compressed = original;
  if (level !== 'none') {
    const encoded = await encodeImage(decoded, info, level);
    if (encoded.bytes.length < info.bytes * KEEP_IF_ABOVE) {
      compressedBytes = encoded.bytes.length;
      size = { width: encoded.width, height: encoded.height };
      const scale = encoded.width / decoded.width;
      const region = {
        left: Math.floor(left * scale),
        top: Math.floor(top * scale),
        width: Math.max(1, Math.min(encoded.width - Math.floor(left * scale), Math.round(side * scale))),
        height: Math.max(1, Math.min(encoded.height - Math.floor(top * scale), Math.round(side * scale))),
      };
      compressed = await sharp(encoded.bytes).extract(region).resize(side, side, { fit: 'fill', kernel: 'cubic' }).jpeg({ quality: 92 }).toBuffer();
    }
  }
  return {
    page,
    original: `data:image/jpeg;base64,${original.toString('base64')}`,
    compressed: `data:image/jpeg;base64,${compressed.toString('base64')}`,
    originalBytes: info.bytes,
    compressedBytes,
    originalSize: { width: info.width, height: info.height },
    compressedSize: size,
    imagesOnPage: infos.length,
  };
}
