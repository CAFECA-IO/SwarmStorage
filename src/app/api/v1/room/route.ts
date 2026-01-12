import { promises as fs } from 'fs';
import path from 'path';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';

const ROOM_BASE_DIR = path.join(process.cwd(), 'room');

export async function POST() {
  try {
    // Info: (20260113 - Luphia) Ensure room directory exists
    try {
      await fs.access(ROOM_BASE_DIR);
    } catch {
      await fs.mkdir(ROOM_BASE_DIR, { recursive: true });
    }

    // Info: (20260113 - Luphia) Clean up empty rooms
    try {
      const items = await fs.readdir(ROOM_BASE_DIR);
      for (const item of items) {
        const itemPath = path.join(ROOM_BASE_DIR, item);
        try {
          const stat = await fs.stat(itemPath);
          if (stat.isDirectory()) {
            // Info: (20260113 - Luphia) Check for expiration
            try {
              const configPath = path.join(itemPath, '_config.json');
              const configContent = await fs.readFile(configPath, 'utf-8');
              const config = JSON.parse(configContent);

              if (config.expiration?.expiresAt && Date.now() > config.expiration.expiresAt) {
                await fs.rm(itemPath, { recursive: true, force: true });
                console.log(`[Room] Removed expired room: ${item}`);
                continue;
              }
            } catch {
              // Info: (20260113 - Luphia) Ignore config errors (file missing or invalid json)
            }

            const files = await fs.readdir(itemPath);
            if (files.filter(f => f !== '_config.json').length === 0) {
              await fs.rmdir(itemPath);
              console.log(`[Room] Removed empty room: ${item}`);
            }
          }
        } catch (err) {
          console.warn(`[Room] Failed to check/remove ${item}:`, err);
        }
      }
    } catch (cleanupErr) {
      console.warn('[Room] Cleanup error:', cleanupErr);
    }

    let roomNumber = '';
    let attempts = 0;
    const maxAttempts = 100;

    while (attempts < maxAttempts) {
      // Info: (20260113 - Luphia) Generate 6-digit random number (000000 - 999999)
      roomNumber = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
      const roomPath = path.join(ROOM_BASE_DIR, roomNumber);

      try {
        await fs.access(roomPath);
        // Info: (20260113 - Luphia) If access succeeds, folder exists, try again
        attempts++;
      } catch {
        // Info: (20260113 - Luphia) If access fails, folder does not exist, create it
        await fs.mkdir(roomPath);
        console.log(`[Room] Created new room: ${roomNumber}`);
        return jsonOk({ roomNumber }, "Room created successfully");
      }
    }

    return jsonFail(ApiCode.SERVER_ERROR, "Failed to generate a unique room number");

  } catch (error) {
    console.error('[Room] Error creating room:', error);
    return jsonFail(ApiCode.SERVER_ERROR, "Internal Server Error");
  }
}
