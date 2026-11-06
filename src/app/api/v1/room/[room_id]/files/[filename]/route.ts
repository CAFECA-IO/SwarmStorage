import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, memberHashFromRequest } from '@/lib/room_access';
import { deleteFile, isValidFilename } from '@/lib/room_store';

export const dynamic = 'force-dynamic';

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Info: (20261106 - Luphia) 處理 DELETE /api/v1/room/[room_id]/files/[filename]
 * 上傳者或房主可刪除；檔案先移到待刪除區，10 秒內可用 restore 復原
 */
export async function DELETE(
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

    const result = await deleteFile(roomId, access.roomPath, access.config, memberHash, filename);
    if (!result.ok) return jsonFail(result.status === 'forbidden' ? ApiCode.FORBIDDEN : ApiCode.NOT_FOUND, result.message);
    return jsonOk({ filename, undoUntil: result.undoUntil }, 'File deleted');
  } catch (error) {
    console.error('[Room Files] Error deleting file:', error instanceof Error ? error.message : error);
    return jsonFail(ApiCode.SERVER_ERROR, 'Internal Server Error');
  }
}
