
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';

const ROOM_BASE_DIR = path.join(process.cwd(), 'room');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const roomPath = path.join(ROOM_BASE_DIR, roomId);

    // Info: (20260113 - Luphia) Validate room exists
    try {
      await fs.access(roomPath);
    } catch {
      return jsonFail(ApiCode.NOT_FOUND, "Room not found");
    }

    const body = await request.json();
    const { minutes } = body;

    if (!minutes || typeof minutes !== 'number' || minutes <= 0) {
      return jsonFail(ApiCode.VALIDATION_ERROR, "Invalid expiration time");
    }

    const expiresAt = Date.now() + minutes * 60 * 1000;
    const expirationData = {
      expiresAt,
      setAt: Date.now(),
      minutes
    };

    const configPath = path.join(roomPath, '_config.json');

    interface IRoomConfig {
      passwordHash?: string;
      expiration?: {
        expiresAt: number;
        setAt: number;
        minutes: number;
      };
    }

    // Info: (20260113 - Luphia) Read existing config or create new
    let config: IRoomConfig = {};
    try {
      const existing = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(existing);
    } catch {
      // Info: (20260113 - Luphia) ignore
    }

    config.expiration = expirationData;

    // Info: (20260113 - Luphia) Save config
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return jsonOk({ expiresAt }, "Expiration set successfully");

  } catch (error) {
    console.error('[Room Expiration API] Error setting expiration:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}
