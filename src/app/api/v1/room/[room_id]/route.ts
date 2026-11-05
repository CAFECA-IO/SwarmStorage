import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { checkRoomAccess, isValidRoomId } from '@/lib/room_access';

const ROOM_BASE_DIR = path.join(process.cwd(), 'room');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    if (!isValidRoomId(roomId)) {
      return jsonFail(ApiCode.VALIDATION_ERROR, "Invalid room number");
    }
    const roomPath = path.join(ROOM_BASE_DIR, roomId);

    // Info: (20260113 - Luphia) Validate room exists
    try {
      await fs.access(roomPath);
    } catch {
      return jsonFail(ApiCode.NOT_FOUND, "Room not found");
    }

    // Info: (20260113 - Luphia) Parse Metadata
    const metadata = await request.json();
    if (!metadata || !metadata.filename) {
      return jsonFail(ApiCode.VALIDATION_ERROR, "Invalid metadata");
    }

    const filename = `${metadata.filename}.json`;
    const filePath = path.join(roomPath, filename);

    // Info: (20260113 - Luphia) Save to file
    await fs.writeFile(filePath, JSON.stringify(metadata, null, 2));

    return jsonOk({ filename }, "Metadata saved to room");

  } catch (error) {
    console.error('[Room API] Error saving metadata:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;

    // Info: (20261105 - Luphia) 共用房間存取檢查：房號格式、存在、到期、密碼
    const access = await checkRoomAccess(roomId, request.headers.get('x-room-password'));
    if (!access.ok) {
      return jsonFail(access.code, access.message);
    }
    const { roomPath } = access;

    const files = await fs.readdir(roomPath);
    const metadataList = [];

    for (const file of files) {
      if (file === '_config.json') continue; // Info: (20260113 - Luphia) Skip config file
      // Info: (20260113 - Luphia) Legacy skilling (optional, but good for safety)
      if (file === 'password.hash') continue;
      if (file === 'expiration.json') continue;

      if (file.endsWith('.json') && file !== 'metadata.json') { // Info: (20260113 - Luphia) Exclude folder metadata if any
        try {
          const content = await fs.readFile(path.join(roomPath, file), 'utf-8');
          const metadata = JSON.parse(content);
          metadataList.push(metadata);
        } catch (err) {
          console.warn(`[Room API] Failed to read/parse ${file}:`, err);
        }
      }
    }

    return jsonOk(metadataList, "OK");

  } catch (error) {
    console.error('[Room API] Error listing files:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}
