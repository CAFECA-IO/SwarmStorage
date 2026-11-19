/**
 * Info: (20261118 - Luphia)
 * 文件在共筆以外的地方被改動 (重新上傳、刪除、復原) 時通知 doc_hub 丟棄記憶體中的版本
 * 以註冊方式連接，避免 room_store 與 doc_hub 互相 import
 */
type THandler = (roomId: string, filename: string) => void;
const holder = globalThis as unknown as { drophereDocInvalidate?: THandler };

export const onDocChangedElsewhere = (handler: THandler) => {
  holder.drophereDocInvalidate = handler;
};

export const notifyDocChangedElsewhere = (roomId: string, filename: string) => holder.drophereDocInvalidate?.(roomId, filename);
