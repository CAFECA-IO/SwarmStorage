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
    const roomPath = path.join(ROOM_BASE_DIR, roomId);

    // Info: (20260113 - Luphia) Validate room exists
    try {
      await fs.access(roomPath);
    } catch {
      return jsonFail(ApiCode.NOT_FOUND, "Room not found");
    }

    // Info: (20260113 - Luphia) Check config (Expiration & Password)
    try {
      const configPath = path.join(roomPath, '_config.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent);

      // Info: (20260113 - Luphia) 1. Check Expiration
      if (config.expiration && config.expiration.expiresAt) {
        if (Date.now() > config.expiration.expiresAt) {
          return jsonFail(ApiCode.NOT_FOUND, "Room expired");
        }
      }

      // Info: (20260113 - Luphia) 2. Check Password
      if (config.passwordHash) {
        const providedPassword = request.headers.get('x-room-password');
        if (!providedPassword) {
          // Info: (20260113 - Luphia) We return 401 with a specific code so frontend knows to prompt
          return jsonFail(ApiCode.UNAUTHORIZED, "Password required");
        }
        const providedHash = keccak256(toUtf8Bytes(providedPassword));
        if (providedHash !== config.passwordHash) {
          return jsonFail(ApiCode.UNAUTHORIZED, "Invalid password");
        }
      }

    } catch {
      // Info: (20260113 - Luphia) No config or error reading it -> assume valid (no password, no expiration)
    }

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
