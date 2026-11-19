import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { findChrome, renderPdf } from '@/lib/pdf_server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_HTML_BYTES = 40 * 1024 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;
const recent = new Map<string, number[]>();

/**
 * Info: (20261118 - Luphia) GET /api/v1/room/[room_id]/pdf：伺服器是否能產生 PDF
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHashFromRequest(request.headers));
  if (!access.ok) return jsonFail(access.code, access.message);
  return jsonOk({ available: !!findChrome() });
}

/**
 * Info: (20261118 - Luphia)
 * POST /api/v1/room/[room_id]/pdf：把文件 HTML 轉成 PDF (房間成員才能使用)
 * body: { html, title }；回傳 application/pdf (不加頁首頁尾)
 * 伺服器沒有 Chrome / Chromium 時回傳 501，前端改用瀏覽器列印
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  const memberHash = memberHashFromRequest(request.headers);
  const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
  if (!access.ok) return jsonFail(access.code, access.message);
  if (!findChrome()) return jsonFail(ApiCode.SERVER_ERROR, 'PDF rendering is not available on this server', { status: 501 });

  const key = memberHash ?? request.headers.get('x-forwarded-for') ?? 'anonymous';
  const now = Date.now();
  const times = (recent.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX) return jsonFail(ApiCode.RATE_LIMIT, 'Too many PDFs in a short time, try again in a minute');
  recent.set(key, [...times, now]);

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_HTML_BYTES) return jsonFail(ApiCode.VALIDATION_ERROR, 'Document is too large to turn into a PDF');
  let body: { html?: unknown; title?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_HTML_BYTES) return jsonFail(ApiCode.VALIDATION_ERROR, 'Document is too large to turn into a PDF');
    body = JSON.parse(text);
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid request');
  }
  if (typeof body.html !== 'string' || !body.html.startsWith('<!doctype html>')) return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid document');

  try {
    const pdf = await renderPdf({ html: body.html });
    return new Response(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[PDF] render failed:', err);
    return jsonFail(ApiCode.SERVER_ERROR, 'The PDF could not be created');
  }
}
