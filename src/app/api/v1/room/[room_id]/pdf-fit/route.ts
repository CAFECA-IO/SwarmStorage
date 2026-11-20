import { NextRequest } from 'next/server';
import { jsonFail, jsonOk } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { getAnalysis, getSample, listJobs, startJob, stopJob, type IStartFit, type TFitResult } from '@/lib/pdf_fit_jobs';
import { FIT_LEVELS, type TFitLevel } from '@/lib/pdf_fit_plan';

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

const respond = <T,>(result: TFitResult<T>) => (result.ok ? jsonOk(result.data) : jsonFail(CODES[result.status], result.message));

/**
 * Info: (20261120 - Luphia) GET /api/v1/room/[room_id]/pdf-fit (Authorization: Bearer <chat token>)
 * - 不帶參數：房間內的壓縮分割工作
 * - ?file=<name>：分析 (頁數、每頁大小、章節、各壓縮等級的估計)
 * - ?file=<name>&page=<n>&level=<level>：該頁影像的壓縮前後比較
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  const search = request.nextUrl.searchParams;
  const file = search.get('file');
  const token = tokenOf(request);
  try {
    if (!file) return respond(await listJobs(roomId, token));
    if (search.has('page')) {
      const level = search.get('level') || 'balanced';
      if (!(level in FIT_LEVELS)) return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid compression level');
      return respond(await getSample(roomId, token, file, Number(search.get('page')), level as TFitLevel));
    }
    return respond(await getAnalysis(roomId, token, file));
  } catch (err) {
    console.error('[PdfFit] request failed:', err);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}

/**
 * Info: (20261120 - Luphia) POST /api/v1/room/[room_id]/pdf-fit
 * body：{ action: 'start', file, limitMb, level, snap, ends? } 或 { action: 'stop', id }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ room_id: string }> }) {
  const { room_id: roomId } = await params;
  let body: IStartFit & { action?: unknown; id?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const token = tokenOf(request);
  try {
    if (body.action === 'start') return respond(await startJob(roomId, token, body));
    if (body.action === 'stop') return respond(await stopJob(roomId, token, body.id));
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Unknown action');
  } catch (err) {
    console.error('[PdfFit] action failed:', err);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
