import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { sessionFromHeaders } from '@/lib/auth_session';
import { listRoomFiles, saveFileMetadata, type TFileMetadata } from '@/lib/room_store';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261106 - Luphia) 處理 POST /api/v1/room/[room_id]
 * 新增或更新檔案 metadata
 * - 需要房間存取權 (密碼或房主)，並依房間的上傳權限檢查
 * - 記錄上傳者代號；同名檔案只有上傳者或房主可覆寫 (新上傳會自動改名)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const memberHash = memberHashFromRequest(request.headers);
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
    if (!access.ok) return jsonFail(access.code, access.message);

    let metadata: TFileMetadata;
    try {
      metadata = await request.json();
    } catch {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid metadata');
    }
    if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.shards)) {
      return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid metadata');
    }

    const uploadIdHeader = request.headers.get('x-upload-id');
    const uploadId = uploadIdHeader && /^[A-Za-z0-9_-]{6,64}$/.test(uploadIdHeader) ? uploadIdHeader : null;
    const handle = sessionFromHeaders(request.headers)?.handle ?? null;
    // Info: (20261108 - Luphia) 資料夾上傳：同一個上傳包的檔案帶相同的 x-upload-bundle
    const bundleHeader = request.headers.get('x-upload-bundle');
    const bundleId = uploadId && bundleHeader && /^[A-Za-z0-9_-]{6,64}$/.test(bundleHeader) ? bundleHeader : null;
    const result = await saveFileMetadata(roomId, access.roomPath, access.config, memberHash, metadata, uploadId, handle, bundleId);
    if (!result.ok) {
      return jsonFail(result.status === 'forbidden' ? ApiCode.FORBIDDEN : ApiCode.VALIDATION_ERROR, result.message);
    }
    return jsonOk({ filename: result.metadata.filename, metadata: result.metadata }, 'Metadata saved to room');
  } catch (error) {
    console.error('[Room API] Error saving metadata:', error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}

/**
 * Info: (20260113 - Luphia) 處理 GET /api/v1/room/[room_id]：房間內的檔案 metadata
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    // Info: (20261105 - Luphia) 共用房間存取檢查：房號格式、存在、到期、密碼 (房主免密碼)
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHashFromRequest(request.headers));
    if (!access.ok) return jsonFail(access.code, access.message);
    return jsonOk(await listRoomFiles(access.roomPath), 'OK');
  } catch (error) {
    console.error('[Room API] Error listing files:', error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
