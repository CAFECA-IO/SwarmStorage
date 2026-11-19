import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { broadcastRoomEvent, onlineIdentities, resolveChatToken } from '@/lib/chat_hub';
import { ROOM_BASE_DIR, canUpload, isRoomOwner, isValidRoomId, readRoomConfig, uploaderIdFor } from '@/lib/room_access';
import { isValidFilename, readFileMetadata, readRoomFileBytes, writeDocVersion } from '@/lib/room_store';
import { joinBlocks, splitBlocks } from '@/lib/doc_blocks';
import { joinFrontMatter, splitFrontMatter } from '@/lib/doc_settings';
import { onDocChangedElsewhere } from '@/lib/doc_invalidate';

/**
 * Info: (20261118 - Luphia)
 * 文件共筆 (伺服器端，記憶體 + 檔案)
 * - 開啟中的文件由伺服器保存一份「區塊清單」(每個區塊有固定 id)，所有修改都經過這裡，再即時推送給房間內的人
 * - 編輯鎖：同一個區塊同時只有一人能改 (45 秒沒有續約自動釋放)，因此不會互相覆蓋
 * - 分工：章節 (## 標題) 可指派負責人與進度；「只有負責人能改自己的章節」模式下依章節檢查權限
 * - 留言、修改紀錄 (可還原) 與區塊 id 存在房間的 .docs/ 之下；文件內容停止修改 3 秒後由伺服器寫回房間
 */

export type TSectionStatus = 'todo' | 'writing' | 'review' | 'done';
export type TDocAccess = 'everyone' | 'assignees';

export interface IDocPerson {
  id: string;
  name: string;
}
export interface IDocBlockState {
  id: string;
  text: string;
}
export interface IDocSection {
  assignee: IDocPerson | null;
  status: TSectionStatus;
}
export interface IDocReply {
  id: string;
  by: IDocPerson;
  text: string;
  at: number;
}
export interface IDocComment {
  id: string;
  blockId: string;
  quote: string;
  by: IDocPerson;
  text: string;
  at: number;
  resolved: boolean;
  replies: IDocReply[];
}
export type THistoryKind = 'edit' | 'insert' | 'delete' | 'settings' | 'rewrite' | 'restore';
export interface IDocHistoryEntry {
  id: string;
  at: number;
  by: IDocPerson;
  kind: THistoryKind;
  blockId: string | null;
  before: string | null;
  after: string | null;
  afterId: string | null;
}

export type TDocOp =
  | { type: 'replace'; id: string; blocks: IDocBlockState[] }
  | { type: 'insert'; afterId: string | null; blocks: IDocBlockState[] }
  | { type: 'front'; front: string | null }
  | { type: 'reset'; front: string | null; blocks: IDocBlockState[] };

interface ILock {
  memberId: string;
  person: IDocPerson;
  until: number;
}

interface ISession {
  key: string;
  roomId: string;
  roomPath: string;
  filename: string;
  front: string | null;
  blocks: IDocBlockState[];
  rev: number;
  savedRev: number;
  savedAt: number;
  access: TDocAccess;
  sections: Record<string, IDocSection>;
  comments: IDocComment[];
  history: IDocHistoryEntry[];
  people: Record<string, string>;
  locks: Map<string, ILock>;
  viewers: Map<string, { person: IDocPerson; until: number }>;
  creatorId: string | null;
  fileTimer: ReturnType<typeof setTimeout> | null;
  metaTimer: ReturnType<typeof setTimeout> | null;
  firstDirtyAt: number;
  lastActive: number;
  editors: Set<string>;
}

interface IMetaFile {
  v: 1;
  filename: string;
  access: TDocAccess;
  sections: Record<string, IDocSection>;
  comments: IDocComment[];
  history: IDocHistoryEntry[];
  people: Record<string, string>;
  blocks: IDocBlockState[];
}

const LOCK_MS = 45 * 1000;
const VIEWER_MS = 45 * 1000;
const SAVE_DEBOUNCE_MS = 3000;
const SAVE_MAX_WAIT_MS = 15 * 1000;
const META_DEBOUNCE_MS = 1000;
const IDLE_EVICT_MS = 10 * 60 * 1000;
const MAX_HISTORY = 300;
const HISTORY_SENT = 100;
const MAX_COMMENTS = 500;
const MAX_TEXT = 200 * 1024;
const MAX_DOC = 2 * 1024 * 1024;
const MAX_COMMENT = 2000;
const STATUSES: TSectionStatus[] = ['todo', 'writing', 'review', 'done'];

interface IHubState {
  sessions: Map<string, ISession>;
  loading: Map<string, Promise<ISession | null>>;
  sweeper?: ReturnType<typeof setInterval>;
}
const globalForDocs = globalThis as unknown as { drophereDocHub?: IHubState };
const state: IHubState = globalForDocs.drophereDocHub ?? { sessions: new Map(), loading: new Map() };
globalForDocs.drophereDocHub = state;

const newId = () => randomBytes(6).toString('base64url');
const keyOf = (roomId: string, filename: string) => `${roomId}\u0000${filename}`;
const metaPathOf = (roomPath: string, filename: string) =>
  path.join(roomPath, '.docs', `${createHash('sha1').update(filename).digest('hex')}.json`);

const sourceOf = (s: ISession) => joinFrontMatter(s.front, joinBlocks(s.blocks.map(b => b.text)));

const textsOf = (text: string) => splitBlocks(text).map(b => b.text);

// Info: (20261118 - Luphia) 依舊的區塊清單沿用 id (內容相同者，依順序比對)
function assignIds(texts: string[], previous: IDocBlockState[]): IDocBlockState[] {
  let from = 0;
  const used = new Set<string>();
  return texts.map(text => {
    for (let k = from; k < previous.length; k++) {
      if (previous[k].text === text && !used.has(previous[k].id)) {
        from = k + 1;
        used.add(previous[k].id);
        return { id: previous[k].id, text };
      }
    }
    return { id: newId(), text };
  });
}

function emit(s: ISession, payload: Record<string, unknown>) {
  broadcastRoomEvent(s.roomId, { type: 'doc', filename: s.filename, payload });
}

function presenceOf(s: ISession) {
  const now = Date.now();
  const locks: Record<string, { memberId: string; name: string }> = {};
  s.locks.forEach((lock, id) => {
    if (lock.until > now) locks[id] = { memberId: lock.memberId, name: lock.person.name };
  });
  const viewers: { memberId: string; id: string; name: string }[] = [];
  s.viewers.forEach((v, memberId) => {
    if (v.until > now) viewers.push({ memberId, id: v.person.id, name: v.person.name });
  });
  return { locks, viewers };
}

function metaOf(s: ISession) {
  return {
    access: s.access,
    sections: s.sections,
    comments: s.comments,
    history: s.history.slice(-HISTORY_SENT),
    historyTotal: s.history.length,
    people: s.people,
    creatorId: s.creatorId,
  };
}

const emitPresence = (s: ISession) => emit(s, { kind: 'presence', ...presenceOf(s) });
const emitMeta = (s: ISession) => emit(s, { kind: 'meta', ...metaOf(s) });

function scheduleMeta(s: ISession) {
  if (s.metaTimer) clearTimeout(s.metaTimer);
  s.metaTimer = setTimeout(() => {
    s.metaTimer = null;
    writeMeta(s).catch(err => console.error('[Docs] meta write failed:', err));
  }, META_DEBOUNCE_MS);
}

async function writeMeta(s: ISession) {
  const file = metaPathOf(s.roomPath, s.filename);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const data: IMetaFile = {
    v: 1,
    filename: s.filename,
    access: s.access,
    sections: s.sections,
    comments: s.comments,
    history: s.history,
    people: s.people,
    blocks: s.blocks,
  };
  await fs.writeFile(file, JSON.stringify(data));
}

function scheduleSave(s: ISession) {
  const now = Date.now();
  if (!s.firstDirtyAt) s.firstDirtyAt = now;
  if (s.fileTimer) clearTimeout(s.fileTimer);
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, s.firstDirtyAt + SAVE_MAX_WAIT_MS - now));
  s.fileTimer = setTimeout(() => {
    s.fileTimer = null;
    persist(s).catch(err => console.error('[Docs] save failed:', err));
  }, wait);
}

async function persist(s: ISession) {
  if (s.rev === s.savedRev) return;
  const rev = s.rev;
  const editors = [...s.editors].slice(0, 5).join(', ') || null;
  s.firstDirtyAt = 0;
  s.editors.clear();
  try {
    await writeDocVersion(s.roomId, s.roomPath, s.filename, sourceOf(s), { memberHash: null, name: null }, editors);
    s.savedRev = Math.max(s.savedRev, rev);
    s.savedAt = Date.now();
    emit(s, { kind: 'saved', rev: s.savedRev, at: s.savedAt });
    await writeMeta(s);
  } catch (err) {
    emit(s, { kind: 'save-error', message: 'The document could not be saved to the room, retrying' });
    scheduleSave(s);
    throw err;
  }
  if (s.rev !== s.savedRev) scheduleSave(s);
}

async function loadSession(roomId: string, filename: string): Promise<ISession | null> {
  const roomPath = path.join(ROOM_BASE_DIR, roomId);
  const metadata = await readFileMetadata(roomPath, filename);
  if (!metadata) return null;
  const size = Number(metadata.originalFileSize) || 0;
  if (size > MAX_DOC) throw new Error('This document is too large to edit together');
  const source = new TextDecoder().decode(await readRoomFileBytes(metadata));
  const { front, body } = splitFrontMatter(source);
  let side: IMetaFile | null = null;
  try {
    side = JSON.parse(await fs.readFile(metaPathOf(roomPath, filename), 'utf-8'));
  } catch {
    side = null;
  }
  const blocks = assignIds(textsOf(body), side?.blocks ?? []);
  return {
    key: keyOf(roomId, filename),
    roomId,
    roomPath,
    filename,
    front,
    blocks,
    rev: 1,
    savedRev: 1,
    savedAt: Number(metadata.editedAt ?? metadata.uploadedAt) || Date.now(),
    access: side?.access === 'assignees' ? 'assignees' : 'everyone',
    sections: side?.sections ?? {},
    comments: side?.comments ?? [],
    history: side?.history ?? [],
    people: side?.people ?? {},
    locks: new Map(),
    viewers: new Map(),
    creatorId: typeof metadata.uploaderId === 'string' ? metadata.uploaderId : null,
    fileTimer: null,
    metaTimer: null,
    firstDirtyAt: 0,
    lastActive: Date.now(),
    editors: new Set(),
  };
}

async function getSession(roomId: string, filename: string): Promise<ISession | null> {
  const key = keyOf(roomId, filename);
  const existing = state.sessions.get(key);
  if (existing) return existing;
  let pending = state.loading.get(key);
  if (!pending) {
    pending = loadSession(roomId, filename)
      .then(session => {
        if (session) state.sessions.set(key, session);
        return session;
      })
      .finally(() => state.loading.delete(key));
    state.loading.set(key, pending);
  }
  return pending;
}

// Info: (20261118 - Luphia) 文件在共筆以外被改動 (重新上傳、刪除)：丟棄記憶體版本，請大家重新載入
onDocChangedElsewhere((roomId, filename) => {
  const s = state.sessions.get(keyOf(roomId, filename));
  if (!s) return;
  if (s.fileTimer) clearTimeout(s.fileTimer);
  if (s.metaTimer) clearTimeout(s.metaTimer);
  state.sessions.delete(s.key);
  writeMeta(s).catch(() => undefined);
  emit(s, { kind: 'reload' });
});

if (!state.sweeper) {
  state.sweeper = setInterval(() => {
    const now = Date.now();
    state.sessions.forEach(s => {
      let changed = false;
      s.locks.forEach((lock, id) => {
        if (lock.until <= now) {
          s.locks.delete(id);
          changed = true;
        }
      });
      s.viewers.forEach((v, id) => {
        if (v.until <= now) {
          s.viewers.delete(id);
          changed = true;
        }
      });
      if (changed) emitPresence(s);
      if (s.locks.size === 0 && s.viewers.size === 0 && now - s.lastActive > IDLE_EVICT_MS && s.rev === s.savedRev && !s.metaTimer) {
        state.sessions.delete(s.key);
      }
    });
  }, 10 * 1000);
  state.sweeper.unref?.();
}

// --- Info: (20261118 - Luphia) 身分與權限 ---

interface IActor {
  memberId: string;
  person: IDocPerson;
  memberHash: string | null;
  canWrite: boolean;
  owner: boolean;
}

export type TDocResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; status: 'auth' | 'forbidden' | 'invalid' | 'missing' | 'conflict'; message: string };

const fail = (status: 'auth' | 'forbidden' | 'invalid' | 'missing' | 'conflict', message: string): TDocResult<never> => ({ ok: false, status, message });

async function actorOf(roomId: string, token: string | null): Promise<IActor | null> {
  if (!isValidRoomId(roomId)) return null;
  const entry = resolveChatToken(roomId, token);
  if (!entry) return null;
  const config = await readRoomConfig(path.join(ROOM_BASE_DIR, roomId));
  const id = uploaderIdFor(roomId, entry.memberHash) ?? `m-${entry.memberId}`;
  return {
    memberId: entry.memberId,
    person: { id, name: entry.nickname },
    memberHash: entry.memberHash,
    canWrite: canUpload(config, entry.memberHash),
    owner: isRoomOwner(config, entry.memberHash),
  };
}

const isManager = (s: ISession, a: IActor) => a.owner || (!!s.creatorId && s.creatorId === a.person.id);

// Info: (20261118 - Luphia) 區塊所屬章節：往前找最近的 ## 標題 (標題本身也屬於該章節)；# 標題之前或之上為 null
function sectionOf(s: ISession, blockId: string | null): string | null {
  if (!blockId) return null;
  const index = s.blocks.findIndex(b => b.id === blockId);
  for (let i = index; i >= 0; i--) {
    const depth = headingDepth(s.blocks[i].text);
    if (depth === 2) return s.blocks[i].id;
    if (depth === 1) return null;
  }
  return null;
}

const headingDepth = (text: string): number | null => {
  const match = /^(#{1,6})\s/.exec(text);
  return match ? match[1].length : null;
};

function canEditBlock(s: ISession, a: IActor, blockId: string | null): boolean {
  if (!a.canWrite) return false;
  if (isManager(s, a) || s.access === 'everyone') return true;
  const section = sectionOf(s, blockId);
  return !!section && s.sections[section]?.assignee?.id === a.person.id;
}

const canEditAll = (s: ISession, a: IActor) => a.canWrite && (isManager(s, a) || s.access === 'everyone');

function remember(s: ISession, person: IDocPerson) {
  if (s.people[person.id] !== person.name) {
    s.people[person.id] = person.name;
    return true;
  }
  return false;
}

function touch(s: ISession, a: IActor) {
  s.lastActive = Date.now();
  s.viewers.set(a.memberId, { person: a.person, until: Date.now() + VIEWER_MS });
  if (remember(s, a.person)) scheduleMeta(s);
}

function record(s: ISession, a: IActor, entry: Omit<IDocHistoryEntry, 'id' | 'at' | 'by'>) {
  s.history.push({ id: newId(), at: Date.now(), by: a.person, ...entry });
  if (s.history.length > MAX_HISTORY) s.history.splice(0, s.history.length - MAX_HISTORY);
}

function applyOp(s: ISession, a: IActor, op: TDocOp) {
  s.rev += 1;
  s.editors.add(a.person.name);
  emit(s, { kind: 'op', rev: s.rev, op, by: a.person });
  scheduleSave(s);
  scheduleMeta(s);
  emitMeta(s);
}

const lockHeldByOther = (s: ISession, blockId: string, a: IActor) => {
  const lock = s.locks.get(blockId);
  return !!lock && lock.until > Date.now() && lock.memberId !== a.memberId ? lock : null;
};

function stateOf(s: ISession, a: IActor) {
  return {
    rev: s.rev,
    savedRev: s.savedRev,
    savedAt: s.savedAt,
    front: s.front,
    blocks: s.blocks,
    ...presenceOf(s),
    ...metaOf(s),
    me: { memberId: a.memberId, id: a.person.id, name: a.person.name, canWrite: a.canWrite, manager: isManager(s, a) },
    members: onlineIdentities(s.roomId).map(m => ({ memberId: m.memberId, id: uploaderIdFor(s.roomId, m.memberHash) ?? `m-${m.memberId}`, name: m.nickname })),
  };
}

// --- Info: (20261118 - Luphia) 對外 API ---

export async function openDoc(roomId: string, filename: string, token: string | null): Promise<TDocResult> {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  let s: ISession | null;
  try {
    s = await getSession(roomId, filename);
  } catch (err) {
    return fail('invalid', err instanceof Error ? err.message : 'The document could not be opened');
  }
  if (!s) return fail('missing', 'Document not found');
  touch(s, actor);
  emitPresence(s);
  return { ok: true, data: stateOf(s, actor) };
}

export async function createDoc(roomId: string, filename: string, token: string | null, source: string): Promise<TDocResult> {
  const actor = await actorOf(roomId, token);
  if (!actor) return fail('auth', 'Invalid or expired room token');
  if (!actor.canWrite) return fail('forbidden', 'Only the room owner can add files here');
  if (typeof source !== 'string' || source.length > MAX_DOC) return fail('invalid', 'Invalid document');
  if (!isValidFilename(filename) || !/\.(md|markdown)$/i.test(filename)) return fail('invalid', 'Invalid document name');
  const roomPath = path.join(ROOM_BASE_DIR, roomId);
  if (await readFileMetadata(roomPath, filename)) return fail('conflict', 'A file with this name already exists');
  const handle = actor.person.name.startsWith('@') ? actor.person.name.slice(1) : null;
  try {
    await writeDocVersion(roomId, roomPath, filename, source, { memberHash: actor.memberHash, name: handle }, actor.person.name);
  } catch (err) {
    return fail('invalid', err instanceof Error ? err.message : 'The document could not be created');
  }
  return openDoc(roomId, filename, token);
}

export interface IDocAction {
  action: string;
  id?: unknown;
  afterId?: unknown;
  text?: unknown;
  front?: unknown;
  source?: unknown;
  commentId?: unknown;
  resolved?: unknown;
  sectionId?: unknown;
  status?: unknown;
  assignee?: unknown;
  access?: unknown;
  historyId?: unknown;
}

export async function docAction(roomId: string, filename: string, token: string | null, body: IDocAction): Promise<TDocResult> {
  const a = await actorOf(roomId, token);
  if (!a) return fail('auth', 'Invalid or expired room token');
  const s = await getSession(roomId, filename).catch(() => null);
  if (!s) return fail('missing', 'Document not found');
  touch(s, a);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const blockIndex = (id: string | null) => (id ? s.blocks.findIndex(b => b.id === id) : -1);

  switch (body.action) {
    case 'here': {
      emitPresence(s);
      return { ok: true, data: {} };
    }
    case 'leave': {
      s.viewers.delete(a.memberId);
      s.locks.forEach((lock, id) => lock.memberId === a.memberId && s.locks.delete(id));
      emitPresence(s);
      return { ok: true, data: {} };
    }
    case 'lock': {
      const id = str(body.id);
      if (blockIndex(id) < 0) return fail('missing', 'This part was removed');
      if (!canEditBlock(s, a, id)) return fail('forbidden', s.access === 'assignees' ? 'Only the person assigned to this section can edit it' : 'You cannot edit this document');
      const other = lockHeldByOther(s, id as string, a);
      if (other) return fail('conflict', `${other.person.name} is editing this part`);
      s.locks.forEach((lock, key) => lock.memberId === a.memberId && key !== id && s.locks.delete(key));
      s.locks.set(id as string, { memberId: a.memberId, person: a.person, until: Date.now() + LOCK_MS });
      emitPresence(s);
      return { ok: true, data: { rev: s.rev, text: s.blocks[blockIndex(id)].text } };
    }
    case 'renew': {
      const id = str(body.id);
      const lock = id ? s.locks.get(id) : undefined;
      if (!lock || lock.memberId !== a.memberId) return fail('conflict', 'Your edit lock expired; reopen this part to edit it');
      lock.until = Date.now() + LOCK_MS;
      return { ok: true, data: {} };
    }
    case 'unlock': {
      const id = str(body.id);
      if (id && s.locks.get(id)?.memberId === a.memberId) s.locks.delete(id);
      emitPresence(s);
      return { ok: true, data: {} };
    }
    case 'commit': {
      const id = str(body.id);
      const text = str(body.text);
      const index = blockIndex(id);
      if (index < 0 || text === null || text.length > MAX_TEXT) return fail('invalid', 'This part was removed or is too long');
      const lock = s.locks.get(id as string);
      if (!lock || lock.memberId !== a.memberId) return fail('conflict', 'Your edit lock expired; reopen this part to edit it');
      s.locks.delete(id as string);
      const before = s.blocks[index].text;
      const texts = textsOf(text);
      const blocks = texts.map((t, i) => ({ id: i === 0 ? (id as string) : newId(), text: t }));
      emitPresence(s);
      if (texts.length === 1 && texts[0] === before) return { ok: true, data: { rev: s.rev } };
      s.blocks.splice(index, 1, ...blocks);
      record(s, a, {
        kind: blocks.length === 0 ? 'delete' : 'edit',
        blockId: id,
        before,
        after: blocks.length ? texts.join('\n\n') : null,
        afterId: index > 0 ? s.blocks[index - 1]?.id ?? null : null,
      });
      applyOp(s, a, { type: 'replace', id: id as string, blocks });
      return { ok: true, data: { rev: s.rev } };
    }
    case 'insert': {
      const afterId = str(body.afterId);
      const text = str(body.text);
      if (text === null || text.length > MAX_TEXT) return fail('invalid', 'Invalid text');
      if (afterId && blockIndex(afterId) < 0) return fail('missing', 'This part was removed');
      if (!(afterId ? canEditBlock(s, a, afterId) : canEditAll(s, a))) return fail('forbidden', 'You can only add to the sections assigned to you');
      const blocks = textsOf(text).map(t => ({ id: newId(), text: t }));
      if (blocks.length === 0) return { ok: true, data: { rev: s.rev } };
      s.blocks.splice(afterId ? blockIndex(afterId) + 1 : 0, 0, ...blocks);
      record(s, a, { kind: 'insert', blockId: blocks[0].id, before: null, after: blocks.map(b => b.text).join('\n\n'), afterId });
      applyOp(s, a, { type: 'insert', afterId, blocks });
      return { ok: true, data: { rev: s.rev, ids: blocks.map(b => b.id) } };
    }
    case 'front': {
      const front = body.front === null ? null : str(body.front);
      if (front !== null && front.length > 10000) return fail('invalid', 'Invalid settings');
      if (!canEditAll(s, a)) return fail('forbidden', 'Only the document owner can change the PDF settings');
      const before = s.front;
      s.front = front && front.trim() ? front : null;
      record(s, a, { kind: 'settings', blockId: null, before, after: s.front, afterId: null });
      applyOp(s, a, { type: 'front', front: s.front });
      return { ok: true, data: { rev: s.rev } };
    }
    case 'reset': {
      const source = str(body.source);
      if (source === null || source.length > MAX_DOC) return fail('invalid', 'Invalid document');
      if (!canEditAll(s, a)) return fail('forbidden', 'Only the document owner can rewrite the whole document');
      const busy = [...s.locks.values()].find(lock => lock.until > Date.now() && lock.memberId !== a.memberId);
      if (busy) return fail('conflict', `${busy.person.name} is editing; try again when they finish`);
      const before = sourceOf(s);
      const { front, body: text } = splitFrontMatter(source);
      s.front = front;
      s.blocks = assignIds(textsOf(text), s.blocks);
      record(s, a, { kind: 'rewrite', blockId: null, before, after: source, afterId: null });
      applyOp(s, a, { type: 'reset', front: s.front, blocks: s.blocks });
      return { ok: true, data: { rev: s.rev } };
    }
    case 'restore': {
      const entry = s.history.find(h => h.id === str(body.historyId));
      if (!entry) return fail('missing', 'This change is no longer in the history');
      if (entry.kind === 'rewrite' || entry.kind === 'settings') {
        if (!canEditAll(s, a)) return fail('forbidden', 'Only the document owner can restore this');
        if (entry.kind === 'settings') {
          s.front = entry.before;
          record(s, a, { kind: 'restore', blockId: null, before: null, after: entry.before, afterId: null });
          applyOp(s, a, { type: 'front', front: s.front });
        } else {
          const { front, body: text } = splitFrontMatter(entry.before ?? '');
          s.front = front;
          s.blocks = assignIds(textsOf(text), s.blocks);
          record(s, a, { kind: 'restore', blockId: null, before: null, after: entry.before, afterId: null });
          applyOp(s, a, { type: 'reset', front: s.front, blocks: s.blocks });
        }
        return { ok: true, data: { rev: s.rev } };
      }
      const id = entry.blockId as string;
      const index = blockIndex(id);
      if (index >= 0) {
        if (!canEditBlock(s, a, id)) return fail('forbidden', 'You cannot edit this part');
        const other = lockHeldByOther(s, id, a);
        if (other) return fail('conflict', `${other.person.name} is editing this part`);
        const current = s.blocks[index].text;
        const blocks = textsOf(entry.before ?? '').map((t, i) => ({ id: i === 0 ? id : newId(), text: t }));
        s.blocks.splice(index, 1, ...blocks);
        record(s, a, { kind: 'restore', blockId: id, before: current, after: entry.before, afterId: null });
        applyOp(s, a, { type: 'replace', id, blocks });
      } else {
        if (!entry.before) return { ok: true, data: { rev: s.rev } };
        const afterId = entry.afterId && blockIndex(entry.afterId) >= 0 ? entry.afterId : null;
        if (!(afterId ? canEditBlock(s, a, afterId) : canEditAll(s, a))) return fail('forbidden', 'You cannot restore this part');
        const blocks = textsOf(entry.before).map((t, i) => ({ id: i === 0 ? id : newId(), text: t }));
        s.blocks.splice(afterId ? blockIndex(afterId) + 1 : 0, 0, ...blocks);
        record(s, a, { kind: 'restore', blockId: id, before: null, after: entry.before, afterId });
        applyOp(s, a, { type: 'insert', afterId, blocks });
      }
      return { ok: true, data: { rev: s.rev } };
    }
    case 'comment': {
      const id = str(body.id);
      const text = str(body.text)?.trim();
      const index = blockIndex(id);
      if (index < 0 || !text || text.length > MAX_COMMENT) return fail('invalid', 'Write a comment (up to 2000 characters)');
      if (s.comments.length >= MAX_COMMENTS) s.comments.splice(s.comments.findIndex(c => c.resolved) >= 0 ? s.comments.findIndex(c => c.resolved) : 0, 1);
      s.comments.push({ id: newId(), blockId: id as string, quote: s.blocks[index].text.slice(0, 120), by: a.person, text, at: Date.now(), resolved: false, replies: [] });
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    case 'reply': {
      const comment = s.comments.find(c => c.id === str(body.commentId));
      const text = str(body.text)?.trim();
      if (!comment || !text || text.length > MAX_COMMENT) return fail('invalid', 'Write a reply (up to 2000 characters)');
      comment.replies.push({ id: newId(), by: a.person, text, at: Date.now() });
      if (comment.replies.length > 100) comment.replies.shift();
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    case 'resolve': {
      const comment = s.comments.find(c => c.id === str(body.commentId));
      if (!comment) return fail('missing', 'Comment not found');
      comment.resolved = body.resolved !== false;
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    case 'delete-comment': {
      const index = s.comments.findIndex(c => c.id === str(body.commentId));
      if (index < 0) return fail('missing', 'Comment not found');
      if (s.comments[index].by.id !== a.person.id && !isManager(s, a)) return fail('forbidden', 'You can only delete your own comments');
      s.comments.splice(index, 1);
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    case 'assign': {
      const sectionId = str(body.sectionId);
      if (!sectionId || headingDepth(s.blocks[blockIndex(sectionId)]?.text ?? '') !== 2) return fail('invalid', 'Assign people to ## sections');
      if (!(isManager(s, a) || (s.access === 'everyone' && a.canWrite))) return fail('forbidden', 'Only the document owner can assign sections');
      let assignee: IDocPerson | null = null;
      const raw = body.assignee as { memberId?: unknown; id?: unknown } | null;
      if (raw) {
        const online = onlineIdentities(s.roomId).find(m => m.memberId === raw.memberId);
        if (online) assignee = { id: uploaderIdFor(s.roomId, online.memberHash) ?? `m-${online.memberId}`, name: online.nickname };
        else if (typeof raw.id === 'string' && s.people[raw.id]) assignee = { id: raw.id, name: s.people[raw.id] };
        else return fail('invalid', 'That person is not in this room');
        remember(s, assignee);
      }
      const current = s.sections[sectionId] ?? { assignee: null, status: 'todo' as TSectionStatus };
      s.sections[sectionId] = { ...current, assignee, status: assignee && current.status === 'todo' ? 'todo' : current.status };
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    case 'status': {
      const sectionId = str(body.sectionId);
      const status = str(body.status) as TSectionStatus | null;
      if (!sectionId || blockIndex(sectionId) < 0 || !status || !STATUSES.includes(status)) return fail('invalid', 'Invalid status');
      const current = s.sections[sectionId] ?? { assignee: null, status: 'todo' as TSectionStatus };
      if (!(isManager(s, a) || current.assignee?.id === a.person.id || (s.access === 'everyone' && a.canWrite))) {
        return fail('forbidden', 'Only the person assigned to this section can change its status');
      }
      s.sections[sectionId] = { ...current, status };
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    case 'access': {
      const access = str(body.access);
      if (access !== 'everyone' && access !== 'assignees') return fail('invalid', 'Invalid setting');
      if (!isManager(s, a)) return fail('forbidden', 'Only the document owner can change who can edit');
      s.access = access;
      scheduleMeta(s);
      emitMeta(s);
      return { ok: true, data: {} };
    }
    default:
      return fail('invalid', 'Unknown action');
  }
}
