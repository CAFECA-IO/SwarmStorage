import { useCallback, useRef } from 'react';
import { uploadFile, type ILariaMetadata } from '@/lib/file_operator';
import { memberHeaders } from '@/lib/member';
import { ApiCode } from '@/lib/status';
import type { IRoomChat } from '@/lib/use_room_chat';

// Info: (20261105 - Luphia) crypto.randomUUID 僅限 HTTPS / localhost；getRandomValues 在一般 HTTP 也可用
const createUploadId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');

interface IUseRoomUploaderOptions {
  roomId: string;
  password: string | null;
  allowDownload: boolean;
  chat: IRoomChat;
  onError: (message: string) => void;
}

/**
 * Info: (20261106 - Luphia)
 * 在房間內上傳檔案：分片上傳、即時回報進度 (房間內的人可看到)、完成後寫入房間 metadata
 */
export function useRoomUploader({ roomId, password, allowDownload, chat, onError }: IUseRoomUploaderOptions) {
  const lastReportRef = useRef(new Map<string, number>());

  const uploadOne = useCallback(
    (file: File) => {
      const uploadId = createUploadId();
      let shardsTotal = 0;
      const report = (status: 'uploading' | 'failed', shardsDone: number) =>
        chat.reportUpload({
          uploadId,
          filename: file.name,
          size: file.size,
          mimeType: file.type,
          shardsDone,
          shardsTotal,
          status,
        });

      uploadFile(
        file,
        {
          onShardProgress: (done, total) => {
            shardsTotal = total;
            const now = Date.now();
            const last = lastReportRef.current.get(uploadId) ?? 0;
            if (done === 0 || done === total || now - last >= 1000) {
              lastReportRef.current.set(uploadId, now);
              report('uploading', done);
            }
          },
          onSuccess: async (_cid: string, metadata?: ILariaMetadata) => {
            lastReportRef.current.delete(uploadId);
            if (!metadata) return;
            try {
              const res = await fetch(`/api/v1/room/${roomId}`, {
                method: 'POST',
                headers: memberHeaders({ 'Content-Type': 'application/json', 'x-upload-id': uploadId }, password),
                body: JSON.stringify(metadata),
              });
              const data = await res.json();
              if (data.code !== ApiCode.OK) throw new Error(data.message || 'Upload could not be saved');
            } catch (err) {
              report('failed', 0);
              onError(`${file.name}: ${err instanceof Error ? err.message : 'upload could not be saved'}`);
            }
          },
          onError: error => {
            lastReportRef.current.delete(uploadId);
            report('failed', 0);
            onError(`${file.name}: ${error}`);
          },
        },
        { allowDownload }
      );
    },
    [allowDownload, chat, onError, password, roomId]
  );

  return useCallback((files: File[]) => files.forEach(uploadOne), [uploadOne]);
}
