
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { isValidRoomId } from '@/lib/room_access';
import { updateRoomTokenExpiry } from '@/lib/chat_hub';

const ROOM_BASE_DIR = path.join(process.cwd(), 'room');

/**
 * Info: (20261105 - Luphia) 處理 GET /api/v1/room/[room_id]/expiration
 * 回傳房間到期時間；未設定時 payload 為 { expiresAt: null }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    if (!/^\d{6}$/.test(roomId)) {
      return jsonFail(ApiCode.VALIDATION_ERROR, "Invalid room number");
    }
    const roomPath = path.join(ROOM_BASE_DIR, roomId);

    try {
      await fs.access(roomPath);
    } catch {
      return jsonFail(ApiCode.NOT_FOUND, "Room not found");
    }

    let expiration: { expiresAt: number; setAt: number; minutes: number } | null = null;
    try {
      const config = JSON.parse(await fs.readFile(path.join(roomPath, '_config.json'), 'utf-8'));
      if (config.expiration && typeof config.expiration.expiresAt === 'number') {
        expiration = config.expiration;
      }
    } catch {
      // Info: (20261105 - Luphia) 沒有設定檔 = 未設定到期時間
    }

    if (expiration && Date.now() > expiration.expiresAt) {
      return jsonFail(ApiCode.NOT_FOUND, "Room expired");
    }

    return jsonOk({
      expiresAt: expiration?.expiresAt ?? null,
      setAt: expiration?.setAt ?? null,
      minutes: expiration?.minutes ?? null,
      serverTime: Date.now(),
    }, "OK");
  } catch (error) {
    console.error('[Room Expiration API] Error reading expiration:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}

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
    // Info: (20261105 - Luphia) 同步延長聊天 token 有效期
    updateRoomTokenExpiry(roomId, expiresAt);

    return jsonOk({ expiresAt }, "Expiration set successfully");

  } catch (error) {
    console.error('[Room Expiration API] Error setting expiration:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}
