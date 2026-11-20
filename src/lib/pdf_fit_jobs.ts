import path from 'path';
import { randomUUID } from 'crypto';
import { ROOM_BASE_DIR, isRoomOwner, canUpload, isValidRoomId, readRoomConfig, uploaderIdFor } from '@/lib/room_access';
import { broadcastRoomEvent, resolveChatToken } from '@/lib/chat_hub';
import { hasContentAccess } from '@/lib/room_paid';
import { freeFolderName, readFileMetadata, readRoomFileBytes, writeServerFile, type TFileMetadata } from '@/lib/room_store';
import { FitError, analyzePdf, buildPart, compressPdf, loadPdf, measureCompressed, prepareForSplit, sampleCompare, type ILoadedPdf } from '@/lib/pdf_fit_engine';
import {
  FIT_LEVELS,
  MAX_LIMIT_MB,
  MB,
  MIN_LIMIT_MB,
  compressedNameFor,
  estimateTotal,
  formatLimit,
  formatSize,
  partNamesFor,
  partsFolderFor,
  partsFromEnds,
  planParts,
  type IFitJobPart,
  type IPdfAnalysis,
  type IPdfChapter,
  type IPdfFitJob,
  type TFitLevel,
} from '@/lib/pdf_fit_plan';

/**
 * Info: (20261120 - Luphia)
 * PDF 壓縮與分割的背景工作 (單一 Node 程序，記憶體內)：
 * - 分析結果快取 10 分鐘 (最多 2 份)，供對話框估計、自訂切點與預覽比較
 * - 一次只執行一個工作 (CPU 密集)，其他排隊；進度即時推送給房間內所有人 (type: 'pdf-job')
 * - 完成的工作保留 2 小時，讓晚進房的人也看得到結果
 */

const MAX_INPUT_BYTES = (Number(process.env.PDF_FIT_MAX_MB) || 600) * MB;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 2;
const KEEP_FINISHED_MS = 2 * 60 * 60 * 1000;
const EMIT_INTERVAL_MS = 400;
const MAX_QUEUED_PER_ROOM = 5;

type TFail = { ok: false; status: 'auth' | 'forbidden' | 'invalid' | 'missing' | 'conflict'; message: string };
export type TFitResult<T> = { ok: true; data: T } | TFail;
const fail = (status: TFail['status'], message: string): TFail => ({ ok: false, status, message });

interface IActor {
  memberId: string;
  nickname: string;
  memberHash: string | null;
  canWrite: boolean;
  owner: boolean;
  roomPath: string;
}

interface ICacheEntry {
  key: string;
  bytes: Uint8Array | null;
  loaded: Promise<ILoadedPdf>;
  usedAt: number;
}

interface IJobInternal {
  job: IPdfFitJob;
  roomId: string;
  roomPath: string;
  memberHash: string | null;
  metadata: TFileMetadata;
  snap: boolean;
  ends: number[] | null;
  stop: boolean;
  lastEmit: number;
}

interface IFitState {
  cache: ICacheEntry[];
  jobs: Map<string, IJobInternal>;
  queue: string[];
  running: string | null;
}

// Info: (20261120 - Luphia) 掛在 globalThis，避免開發模式熱更新時產生多份狀態
const globalForFit = globalThis as unknown as { drophereFit?: IFitState };
const state: IFitState = globalForFit.drophereFit ?? { cache: [], jobs: new Map(), queue: [], running: null };
globalForFit.drophereFit = state;

async function actorOf(roomId: string, token: string | null): Promise<IActor | null> {
  if (!isValidRoomId(roomId)) return null;
  const entry = resolveChatToken(roomId, token);
  if (!entry) return null;
  const roomPath = path.join(ROOM_BASE_DIR, roomId);
  const config = await readRoomConfig(roomPath);
  return {
    memberId: entry.memberId,
    nickname: entry.nickname,
    memberHash: entry.memberHash,
    canWrite: canUpload(config, entry.memberHash),
    owner: isRoomOwner(config, entry.memberHash),
    roomPath,
  };
}

// Info: (20261120 - Luphia) 讀取原始 PDF：檔案關閉下載時，只有上傳者與房主可以處理
async function sourceOf(roomId: string, actor: IActor, filename: string): Promise<TFitResult<TFileMetadata>> {
  if (!/\.pdf$/i.test(filename)) return fail('invalid', 'Only PDF files can be compressed and split');
  const metadata = await readFileMetadata(actor.roomPath, filename);
  if (!metadata) return fail('missing', 'File not found');
  // Info: (20261120 - Luphia) 付費房：買了 (或房主) 才能處理
  if (!(await hasContentAccess(actor.roomPath, await readRoomConfig(actor.roomPath), actor.memberHash))) return fail('forbidden', 'Unlock this room first');
  const mine = !!actor.memberHash && metadata.uploaderId === uploaderIdFor(roomId, actor.memberHash);
  if (metadata.allowDownload === false && !actor.owner && !mine) return fail('forbidden', 'Downloads are turned off for this file');
  const size = Number(metadata.originalFileSize) || 0;
  if (size > MAX_INPUT_BYTES) return fail('invalid', `PDFs up to ${formatSize(MAX_INPUT_BYTES)} can be processed here`);
  return { ok: true, data: metadata };
}

const cacheKey = (roomId: string, metadata: TFileMetadata) =>
  `${roomId}/${metadata.filename}#${Array.isArray(metadata.shards) ? String(metadata.shards[0]) : ''}`;

function pruneCache() {
  const now = Date.now();
  state.cache = state.cache.filter(entry => now - entry.usedAt < CACHE_TTL_MS).sort((a, b) => b.usedAt - a.usedAt).slice(0, CACHE_MAX);
}

// Info: (20261120 - Luphia) 分析 (同一檔案同時只做一次)
function analysisFor(roomId: string, metadata: TFileMetadata, onProgress?: (fraction: number) => void): ICacheEntry {
  pruneCache();
  const key = cacheKey(roomId, metadata);
  const hit = state.cache.find(entry => entry.key === key);
  if (hit) {
    hit.usedAt = Date.now();
    return hit;
  }
  const entry: ICacheEntry = { key, bytes: null, usedAt: Date.now(), loaded: Promise.resolve(null as unknown as ILoadedPdf) };
  entry.loaded = (async () => {
    const bytes = await readRoomFileBytes(metadata);
    if (bytes.length !== Number(metadata.originalFileSize)) throw new FitError('Part of this file could not be read from storage; try again shortly');
    entry.bytes = bytes;
    onProgress?.(0.4);
    return analyzePdf(bytes, metadata.filename, fraction => onProgress?.(0.4 + fraction * 0.6));
  })();
  entry.loaded.catch(() => {
    state.cache = state.cache.filter(e => e !== entry);
  });
  state.cache.unshift(entry);
  pruneCache();
  return entry;
}

const messageOf = (err: unknown) => (err instanceof FitError ? err.message : 'This PDF could not be processed');

export async function getAnalysis(roomId: string, token: string | null, filename: string): Promise<TFitResult<IPdfAnalysis>> {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  const source = await sourceOf(roomId, actor, filename);
  if (!source.ok) return source;
  try {
    return { ok: true, data: (await analysisFor(roomId, source.data).loaded).analysis };
  } catch (err) {
    if (!(err instanceof FitError)) console.error('[PdfFit] analyze failed:', err);
    return fail('invalid', messageOf(err));
  }
}

export async function getSample(roomId: string, token: string | null, filename: string, page: number, level: TFitLevel) {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  const source = await sourceOf(roomId, actor, filename);
  if (!source.ok) return source;
  try {
    const loaded = await analysisFor(roomId, source.data).loaded;
    if (!Number.isInteger(page) || page < 0 || page >= loaded.analysis.pages) return fail('invalid', 'Invalid page');
    return { ok: true as const, data: { sample: await sampleCompare(loaded, page, level) } };
  } catch (err) {
    if (!(err instanceof FitError)) console.error('[PdfFit] sample failed:', err);
    return fail('invalid', messageOf(err));
  }
}

// --- Info: (20261120 - Luphia) 背景工作 ---

function emit(internal: IJobInternal, force = false) {
  const now = Date.now();
  if (!force && now - internal.lastEmit < EMIT_INTERVAL_MS) return;
  internal.lastEmit = now;
  broadcastRoomEvent(internal.roomId, { type: 'pdf-job', job: { ...internal.job, parts: [...internal.job.parts] } });
}

function update(internal: IJobInternal, patch: Partial<IPdfFitJob>, force = false) {
  Object.assign(internal.job, patch);
  emit(internal, force);
}

function pruneJobs() {
  const now = Date.now();
  state.jobs.forEach((internal, id) => {
    if (internal.job.finishedAt && now - internal.job.finishedAt > KEEP_FINISHED_MS) state.jobs.delete(id);
  });
}

export async function listJobs(roomId: string, token: string | null): Promise<TFitResult<{ jobs: IPdfFitJob[] }>> {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  pruneJobs();
  const jobs = [...state.jobs.values()].filter(j => j.roomId === roomId).map(j => j.job);
  return { ok: true, data: { jobs } };
}

export interface IStartFit {
  file?: unknown;
  limitMb?: unknown;
  level?: unknown;
  snap?: unknown;
  ends?: unknown;
}

export async function startJob(roomId: string, token: string | null, body: IStartFit): Promise<TFitResult<{ job: IPdfFitJob }>> {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  if (!actor.canWrite) return fail('forbidden', 'Only the room owner can add files here');
  const filename = typeof body.file === 'string' ? body.file : '';
  const source = await sourceOf(roomId, actor, filename);
  if (!source.ok) return source;
  const limitMb = Number(body.limitMb);
  if (!Number.isFinite(limitMb) || limitMb < MIN_LIMIT_MB || limitMb > MAX_LIMIT_MB) return fail('invalid', `Choose a size between ${MIN_LIMIT_MB} and ${MAX_LIMIT_MB} MB`);
  const level = typeof body.level === 'string' && body.level in FIT_LEVELS ? (body.level as TFitLevel) : null;
  if (!level) return fail('invalid', 'Invalid compression level');
  const size = Number(source.data.originalFileSize) || 0;
  if (level === 'none' && size <= limitMb * MB) return fail('invalid', `${filename.split('/').pop()} is already under ${formatLimit(limitMb)}`);
  let ends: number[] | null = null;
  if (Array.isArray(body.ends)) {
    if (body.ends.length > 999 || !body.ends.every(e => Number.isInteger(e) && (e as number) >= 0)) return fail('invalid', 'Invalid split points');
    ends = body.ends as number[];
  }
  pruneJobs();
  const busy = [...state.jobs.values()].filter(j => j.roomId === roomId && (j.job.status === 'queued' || j.job.status === 'running'));
  if (busy.some(j => j.job.filename === filename)) return fail('conflict', 'This PDF is already being processed');
  if (busy.length >= MAX_QUEUED_PER_ROOM) return fail('conflict', 'Too many PDFs are waiting in this room; try again when one finishes');

  const job: IPdfFitJob = {
    id: randomUUID(),
    filename,
    limitMb,
    level,
    status: 'queued',
    step: 'analyze',
    progress: 0,
    detail: 'Waiting to start',
    startedBy: { memberId: actor.memberId, nickname: actor.nickname },
    startedAt: Date.now(),
    finishedAt: null,
    pages: 0,
    originalSize: size,
    compressedSize: null,
    folder: null,
    parts: [],
    error: null,
  };
  const internal: IJobInternal = { job, roomId, roomPath: actor.roomPath, memberHash: actor.memberHash, metadata: source.data, snap: body.snap !== false, ends, stop: false, lastEmit: 0 };
  state.jobs.set(job.id, internal);
  state.queue.push(job.id);
  if (state.running) update(internal, { detail: 'Waiting for another PDF to finish' }, true);
  else emit(internal, true);
  pump();
  return { ok: true, data: { job } };
}

export async function stopJob(roomId: string, token: string | null, id: unknown): Promise<TFitResult<{ job: IPdfFitJob }>> {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  const internal = typeof id === 'string' ? state.jobs.get(id) : undefined;
  if (!internal || internal.roomId !== roomId) return fail('missing', 'Job not found');
  const sameMember = internal.memberHash ? internal.memberHash === actor.memberHash : internal.job.startedBy.memberId === actor.memberId;
  if (!actor.owner && !sameMember) return fail('forbidden', 'Only the person who started this, or the room owner, can stop it');
  if (internal.job.status === 'queued') {
    state.queue = state.queue.filter(q => q !== internal.job.id);
    update(internal, { status: 'stopped', detail: 'Stopped', finishedAt: Date.now() }, true);
  } else if (internal.job.status === 'running') {
    if (internal.job.step === 'save') return fail('conflict', 'Almost done — the files are being saved');
    internal.stop = true;
    update(internal, { detail: 'Stopping…' }, true);
  }
  return { ok: true, data: { job: internal.job } };
}

function pump() {
  if (state.running) return;
  const id = state.queue.shift();
  if (!id) return;
  const internal = state.jobs.get(id);
  if (!internal || internal.job.status !== 'queued') {
    pump();
    return;
  }
  state.running = id;
  runJob(internal)
    .catch(err => {
      if (!(err instanceof FitError)) console.error('[PdfFit] job failed:', err);
      update(internal, { status: 'failed', error: messageOf(err), detail: messageOf(err), finishedAt: Date.now() }, true);
    })
    .finally(() => {
      state.running = null;
      pump();
    });
}

class Stopped extends Error {}

// Info: (20261120 - Luphia) 一段所含的章節名稱 (切段依據的那一層)
function chaptersIn(chapters: IPdfChapter[], from: number, to: number): string | null {
  const top = chapters.filter(c => c.level === 0);
  const list = (top.length < 2 ? chapters.filter(c => c.level === 1) : top).filter(c => c.page >= from && c.page <= to);
  if (list.length === 0) return null;
  return list.length === 1 ? list[0].title : `${list[0].title} – ${list[list.length - 1].title}`;
}

async function runJob(internal: IJobInternal) {
  const { job } = internal;
  const checkStop = () => {
    if (internal.stop) throw new Stopped();
  };
  update(internal, { status: 'running', step: 'analyze', progress: 0, detail: 'Reading the PDF' }, true);
  const limit = job.limitMb * MB;
  try {
    // Info: (20261120 - Luphia) 1 · 分析 (沿用對話框的分析結果)
    const entry = analysisFor(internal.roomId, internal.metadata, fraction => update(internal, { progress: fraction }));
    const base = await entry.loaded;
    const bytes = entry.bytes;
    if (!bytes) throw new FitError('This PDF could not be read');
    const doc = await loadPdf(bytes);
    const analysis = base.analysis;
    update(internal, { pages: analysis.pages, progress: 1, detail: `${analysis.pages} pages · ${analysis.images.count} images` }, true);
    checkStop();

    // Info: (20261120 - Luphia) 2 · 壓縮
    update(internal, { step: 'compress', progress: 0, detail: job.level === 'none' ? 'Images unchanged' : 'Resizing images' }, true);
    await compressPdf(
      doc,
      job.level,
      (done, total) => update(internal, { progress: done / total, detail: `Image ${done} of ${total}` }),
      () => internal.stop
    );
    checkStop();
    const compressed = await measureCompressed(doc, analysis);
    const compressedSize = estimateTotal(compressed, 'none');
    update(internal, { compressedSize, progress: 1 }, true);

    // Info: (20261120 - Luphia) 3 · 分割：存檔前每段實際量一次，超過上限再切開
    const ranges = (internal.ends ? partsFromEnds(compressed, 'none', limit, internal.ends) : planParts(compressed, 'none', limit, internal.snap)).map(p => ({
      from: p.from,
      to: p.to,
    }));
    update(internal, { step: 'split', progress: 0, detail: ranges.length > 1 ? `Making ${ranges.length} files` : 'Making the file' }, true);
    prepareForSplit(doc);
    const title = doc.getTitle()?.trim() || internal.metadata.filename.split('/').pop()!.replace(/\.pdf$/i, '');
    const built: { from: number; to: number; bytes: Uint8Array }[] = [];
    const queue = [...ranges];
    while (queue.length) {
      checkStop();
      const range = queue.shift()!;
      const out = await buildPart(doc, range.from, range.to, analysis.chapters, title);
      if (out.length <= limit) {
        built.push({ ...range, bytes: out });
      } else if (range.from === range.to) {
        throw new FitError(
          `Page ${range.from + 1} alone is ${formatSize(out.length)}${job.level === 'none' ? '' : ' after compressing'}. Choose ${job.level === 'strong' ? 'a larger size' : 'stronger compression or a larger size'}.`
        );
      } else {
        // Info: (20261120 - Luphia) 依每頁大小平均切成 k 段 (k = 實際大小 / 上限 × 90%)，避免切出很小的一段
        const k = Math.min(range.to - range.from + 1, Math.ceil(out.length / (limit * 0.9)));
        const weight = (p: number) => (compressed.pageOther[p] ?? 0) + (compressed.pageImage[p] ?? 0) + 1;
        let total = 0;
        for (let p = range.from; p <= range.to; p++) total += weight(p);
        const pieces: { from: number; to: number }[] = [];
        let start = range.from;
        let acc = 0;
        for (let p = range.from; p <= range.to; p++) {
          acc += weight(p);
          const remainingPieces = k - pieces.length - 1;
          const mustStop = range.to - p === remainingPieces;
          if (remainingPieces > 0 && (acc >= (total * (pieces.length + 1)) / k || mustStop)) {
            pieces.push({ from: start, to: p });
            start = p + 1;
          }
        }
        pieces.push({ from: start, to: range.to });
        queue.unshift(...pieces);
      }
      const total = built.length + queue.length;
      update(internal, { progress: built.length / total, detail: `File ${Math.min(built.length + 1, total)} of ${total}` });
    }
    checkStop();

    // Info: (20261120 - Luphia) 4 · 存檔：多個檔案放進資料夾「book (15 MB parts)」，一個檔案放在原檔旁
    const totalBytes = built.reduce((sum, part) => sum + part.bytes.length, 0);
    update(internal, { step: 'save', progress: 0, detail: 'Saving to this room', compressedSize: totalBytes }, true);
    const folder = built.length > 1 ? await freeFolderName(internal.roomPath, partsFolderFor(job.filename, job.limitMb)) : null;
    const names = built.length > 1 ? partNamesFor(job.filename, built.length).map(name => `${folder}/${name}`) : [compressedNameFor(job.filename)];
    const config = await readRoomConfig(internal.roomPath);
    const handle = job.startedBy.nickname.startsWith('@') ? job.startedBy.nickname.slice(1) : null;
    const parts: IFitJobPart[] = [];
    let savedBytes = 0;
    for (let i = 0; i < built.length; i++) {
      const part = built[i];
      const saved = await writeServerFile(internal.roomId, internal.roomPath, names[i], part.bytes, {
        mimeType: 'application/pdf',
        memberHash: internal.memberHash,
        name: handle,
        allowDownload: internal.metadata.allowDownload !== false && config.allowDownload !== false,
        onShard: (done, total) => update(internal, { progress: (savedBytes + (part.bytes.length * done) / total) / totalBytes, detail: `Saving file ${i + 1} of ${built.length}` }),
      });
      savedBytes += part.bytes.length;
      parts.push({ filename: saved.filename, from: part.from, to: part.to, size: part.bytes.length, chapters: chaptersIn(analysis.chapters, part.from, part.to) });
      update(internal, { parts: [...parts] }, true);
    }
    update(
      internal,
      {
        status: 'done',
        progress: 1,
        folder,
        parts,
        detail: built.length > 1 ? `${built.length} files, each under ${formatLimit(job.limitMb)}` : `Saved as ${names[0].split('/').pop()}`,
        finishedAt: Date.now(),
      },
      true
    );
  } catch (err) {
    if (err instanceof Stopped) {
      update(internal, { status: 'stopped', detail: 'Stopped · nothing was saved', finishedAt: Date.now() }, true);
      return;
    }
    throw err;
  }
}
