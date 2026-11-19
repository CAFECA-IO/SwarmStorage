import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { createDoc, docAction, openDoc, type IDocAction, type TDocResult } from '@/lib/doc_hub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const tokenOf = (request: NextRequest) => {
  const auth = request.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
};

const CODES = {
  auth: ApiCode.UNAUTHORIZED,
  forbidden: ApiCode.FORBIDDEN,
  invalid: ApiCode.VALIDATION_ERROR,
  missing: ApiCode.NOT_FOUND,
  conflict: ApiCode.CONFLICT,
} as const;

const respond = (result: TDocResult) => (result.ok ? jsonOk(result.data) : jsonFail(CODES[result.status], result.message));

/**
 * Info: (20261118 - Luphia) GET /api/v1/room/[room_id]/docs?file=<name>
 * 開啟文件共筆：回傳區塊、編輯鎖、章節分工、留言與修改紀錄 (Authorization: Bearer <chat token>)
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  const filename = request.nextUrl.searchParams.get('file') || '';
  try {
    return respond(await openDoc(roomId, filename, tokenOf(request)));
  } catch (err) {
    console.error('[Docs] open failed:', err);
    return jsonFail(ApiCode.SERVER_ERROR, 'The document could not be opened');
  }
}

/**
 * Info: (20261118 - Luphia) POST /api/v1/room/[room_id]/docs
 * body: { file, action, ... }
 * action：create (source)、lock / renew / unlock / commit (id, text)、insert (afterId, text)、front、reset (source)、restore (historyId)、
 * comment (id, text)、reply / resolve / delete-comment (commentId)、assign (sectionId, assignee)、status (sectionId, status)、access、here、leave
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  let body: IDocAction & { file?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const filename = typeof body.file === 'string' ? body.file : '';
  try {
    if (body.action === 'create') return respond(await createDoc(roomId, filename, tokenOf(request), typeof body.source === 'string' ? body.source : ''));
    return respond(await docAction(roomId, filename, tokenOf(request), body));
  } catch (err) {
    console.error('[Docs] action failed:', err);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
