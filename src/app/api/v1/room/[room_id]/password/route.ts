
import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { keccak256, toUtf8Bytes } from 'ethers';

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
    const { password } = body;

    if (!password || typeof password !== 'string') {
      return jsonFail(ApiCode.VALIDATION_ERROR, "Invalid password");
    }

    // Info: (20260113 - Luphia) Hash password
    const hash = keccak256(toUtf8Bytes(password));
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

    config.passwordHash = hash;

    // Info: (20260113 - Luphia) Save config
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return jsonOk(null, "Password set successfully");

  } catch (error) {
    console.error('[Room Password API] Error setting password:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const roomPath = path.join(ROOM_BASE_DIR, roomId);
    const configPath = path.join(roomPath, '_config.json');

    try {
      const existing = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(existing);
      return jsonOk({ hasPassword: !!config.passwordHash }, "OK");
    } catch {
      return jsonOk({ hasPassword: false }, "OK");
    }
  } catch (error) {
    console.error('[Room Password API] Error checking password:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ room_id: string }> }
) {
  try {
    const { room_id: roomId } = await params;
    const roomPath = path.join(ROOM_BASE_DIR, roomId);
    const configPath = path.join(roomPath, '_config.json');

    try {
      const existing = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(existing);

      if (config.passwordHash) {
        delete config.passwordHash;
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      }
      return jsonOk(null, "Password removed successfully");
    } catch {
      return jsonOk(null, "Password already removed");
    }
  } catch (error) {
    console.error('[Room Password API] Error removing password:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}
