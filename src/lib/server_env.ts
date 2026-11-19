import path from 'path';

/**
 * Info: (20261119 - Luphia)
 * 伺服器端的部署設定 (環境變數)；本機開發不設定時沿用原本的預設值
 * - IPFS_API_URL：IPFS API 位址。容器部署時 127.0.0.1 指向 web 容器自己，需改成服務名稱，例如 http://ipfs_bootstrap:5001
 * - ROOM_DATA_DIR：房間資料 (設定、密碼雜湊、檔案 metadata、文件共筆紀錄) 的目錄，需掛 volume 持久化
 * - DROPHERE_DATA_DIR：伺服器自動產生的金鑰 (未設定 SESSION_SECRET 時的登入金鑰) 存放目錄，需持久化
 */

const dirFromEnv = (value: string | undefined, fallback: string) => (value && value.trim() ? path.resolve(value.trim()) : fallback);

export const IPFS_API_URL = (process.env.IPFS_API_URL?.trim() || 'http://127.0.0.1:5001').replace(/\/+$/, '');

export const ROOM_DATA_DIR = dirFromEnv(process.env.ROOM_DATA_DIR, path.join(process.cwd(), 'room'));

export const DROPHERE_DATA_DIR = dirFromEnv(process.env.DROPHERE_DATA_DIR, path.join(process.cwd(), '.drophere'));
