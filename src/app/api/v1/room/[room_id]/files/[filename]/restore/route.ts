import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { isValidFilename, restoreFile } from '@/lib/room_store';

export const dynamic = 'force-dynamic';

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Info: (20261106 - Luphia) 處理 POST /api/v1/room/[room_id]/files/[filename]/restore
 * 在 10 秒內復原剛刪除的檔案
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string; filename: string }> }
) {
  try {
    const { room_id: roomId, filename: rawName } = await params;
    const filename = safeDecode(rawName);
    if (!isValidFilename(filename)) return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid filename');
    const memberHash = memberHashFromRequest(request.headers);
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'), memberHash);
    if (!access.ok) return jsonFail(access.code, access.message);

    const result = await restoreFile(roomId, access.roomPath, access.config, memberHash, filename);
    if (!result.ok) {
      const code = result.status === 'forbidden' ? ApiCode.FORBIDDEN : result.status === 'conflict' ? ApiCode.CONFLICT : ApiCode.NOT_FOUND;
      return jsonFail(code, result.message);
    }
    return jsonOk({ metadata: result.metadata }, 'File restored');
  } catch (error) {
    console.error('[Room Files] Error restoring file:', error instanceof Error ? error.message : error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
