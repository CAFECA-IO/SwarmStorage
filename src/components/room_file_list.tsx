import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { downloadFromMetadata, ILariaMetadata } from '@/lib/file_operator';
import { DownloadIcon, FileIcon } from '@/components/icons';
import { formatBytes } from '@/lib/utils';
import { ApiCode } from '@/lib/status';
import VirtualKeyboard from '@/components/virtual_keyboard';

interface IRoomFileListProps {
  roomId: string;
  initialData?: ILariaMetadata[] | null;
  initialPassword?: string;
  onExit?: () => void;
}

export default function RoomFileList({ roomId, initialData, initialPassword, onExit }: IRoomFileListProps) {
  const router = useRouter();
  const [fileList, setFileList] = useState<ILariaMetadata[] | null>(initialData || null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorHeader, setErrorHeader] = useState('');

  // Info: (20260113 - Luphia) Password state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [roomPassword, setRoomPassword] = useState(initialPassword || '');
  const [passwordError, setPasswordError] = useState('');

  // Info: (20260113 - Luphia) Keyboard state
  const [showKeyboard, setShowKeyboard] = useState(false);

  // Info: (20260113 - Luphia) Download state
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  // Info: (20260113 - Luphia) Preview state
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewProgress, setPreviewProgress] = useState<Record<string, number>>({});

  const fetchRoomFiles = useCallback(async (passwordStr?: string) => {
    setIsLoading(true);
    setPasswordError('');
    setErrorHeader('');
    try {
      const headers: Record<string, string> = {};
      if (passwordStr) {
        headers['x-room-password'] = passwordStr;
      }

      const res = await fetch(`/api/v1/room/${roomId}`, { headers });
      const data = await res.json();

      if (data.code === ApiCode.OK) {
        setFileList(data.payload);
        setShowPasswordModal(false);
      } else if (data.code === ApiCode.UNAUTHORIZED) {
        setShowPasswordModal(true);
        if (passwordStr) setPasswordError('Incorrect password');
      } else {
        setErrorHeader(data.message || 'Failed to load room files');
        setFileList(null);
      }
    } catch (err) {
      console.error(err);
      setErrorHeader('Network error');
    } finally {
      setIsLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    if (!initialData) {
      fetchRoomFiles(initialPassword);
    }
  }, [roomId, initialData, initialPassword, fetchRoomFiles]);

  // Info: (20260113 - Luphia) Cleanup previews on unmount
  useEffect(() => {
    return () => {
      Object.values(previewUrls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [previewUrls]);

  // Info: (20260113 - Luphia) Media Preview Logic
  const getExtension = (filename: string) => filename.split('.').pop()?.toLowerCase() || '';

  const isImage = (filename: string) => ['png', 'jpg', 'jpeg'].includes(getExtension(filename));
  const isVideo = (filename: string) => ['mp4', 'mov', 'm3u8'].includes(getExtension(filename));
  const isAudio = (filename: string) => ['mp3'].includes(getExtension(filename));
  const isMedia = (filename: string) => isImage(filename) || isVideo(filename) || isAudio(filename);

  const shouldAutoPreview = (file: ILariaMetadata) => {
    const ext = getExtension(file.filename);
    const supported = ['png', 'jpg', 'jpeg', 'mp4', 'mov', 'mp3', 'm3u8'].includes(ext);
    // Info: (20260113 - Luphia) Limit auto-load to 50MB
    const sizeLimit = 50 * 1024 * 1024;
    return supported && file.originalFileSize < sizeLimit;
  };

  const loadPreview = (file: ILariaMetadata) => {
    // Info: (20260113 - Luphia) Prevent multiple loads
    if (previewProgress[file.filename] !== undefined || previewUrls[file.filename]) return;

    setPreviewProgress(prev => ({ ...prev, [file.filename]: 0 }));

    downloadFromMetadata(file, {
      onProgress: (p) => {
        setPreviewProgress(prev => ({ ...prev, [file.filename]: p }));
      },
      onSuccess: (blob) => {
        const url = URL.createObjectURL(blob);
        setPreviewUrls(prev => ({ ...prev, [file.filename]: url }));
        setPreviewProgress(prev => {
          const newState = { ...prev };
          delete newState[file.filename];
          return newState;
        });
      },
      onError: (err) => {
        console.error(`Preview load failed for ${file.filename}:`, err);
        setPreviewProgress(prev => {
          const newState = { ...prev };
          delete newState[file.filename];
          return newState;
        });
      }
    });
  };

  // Info: (20260113 - Luphia) Auto-load small previews
  useEffect(() => {
    if (fileList) {
      fileList.forEach(file => {
        if (shouldAutoPreview(file) && !previewUrls[file.filename] && previewProgress[file.filename] === undefined) {
          loadPreview(file);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileList]);

  const handlePasswordSubmit = () => {
    fetchRoomFiles(roomPassword);
  };

  const handlePasswordInput = (char: string) => {
    setRoomPassword(prev => prev + char);
  };

  const handlePasswordDelete = () => {
    setRoomPassword(prev => prev.slice(0, -1));
  };

  const handleDownload = (metadata: ILariaMetadata) => {
    const fileId = metadata.filename;
    setDownloadingFile(fileId);
    setProgress(0);

    downloadFromMetadata(metadata, {
      onProgress: (p) => setProgress(p),
      onSuccess: (blob, filename) => {
        setDownloadingFile(null);
        setProgress(100);

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      },
      onError: (err) => {
        setDownloadingFile(null);
        console.error(`Download failed: ${err}`);
      }
    });
  };

  const renderPreview = (file: ILariaMetadata) => {
    const url = previewUrls[file.filename];
    const progress = previewProgress[file.filename];

    if (!url) {
      if (progress !== undefined) {
        return (
          <div className="w-full mt-2">
            <div className="flex justify-between text-xs text-slate-400 mb-1">
              <span>Loading preview...</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        );
      }

      const ext = getExtension(file.filename);
      const supported = ['png', 'jpg', 'jpeg', 'mp4', 'mov', 'mp3', 'm3u8'].includes(ext);
      if (supported) {
        return (
          <button
            onClick={() => loadPreview(file)}
            className="text-xs text-blue-500 mt-2 hover:underline font-medium flex items-center gap-1"
          >
            <span className="w-4 h-4 rounded-full border border-blue-500 flex items-center justify-center text-[10px]">▶</span>
            Load Preview
          </button>
        );
      }
      return null;
    }

    const preventContext = (e: React.MouseEvent) => e.preventDefault();

    if (isImage(file.filename)) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={file.filename}
          className="mt-2 rounded-lg max-h-[400px] w-auto object-contain bg-black/5 shadow-sm"
          onContextMenu={preventContext}
        />
      );
    }
    if (isVideo(file.filename)) {
      return (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          controls
          controlsList="nodownload"
          src={url}
          className="mt-2 rounded-lg max-h-[400px] w-full max-w-[600px] bg-black shadow-sm"
          aria-label={`Video preview for ${file.filename}`}
          onContextMenu={preventContext}
        />
      );
    }
    if (isAudio(file.filename)) {
      return (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio
          controls
          controlsList="nodownload"
          src={url}
          className="mt-2 w-full max-w-[400px]"
          aria-label={`Audio preview for ${file.filename}`}
          onContextMenu={preventContext}
        />
      );
    }
    return null;
  };

  return (
    <div>
      {/* Info: (20260113 - Luphia) Password Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-2xl animate-fade-in relative overflow-hidden">
            <h3 className="text-lg font-bold text-slate-700 mb-2">Password Required</h3>
            <p className="text-sm text-slate-500 mb-4">This room is protected.</p>

            <div className="bg-slate-50 rounded-xl p-3 mb-4 border border-slate-200">
              <input
                type="password"
                value={roomPassword}
                readOnly
                placeholder="******"
                className="w-full bg-transparent text-center text-2xl font-mono tracking-widest outline-none text-slate-700"
                onFocus={() => setShowKeyboard(true)}
                aria-label="Enter Password"
              />
            </div>

            {passwordError && (
              <p className="text-xs text-red-500 text-center mb-4 font-bold">{passwordError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (onExit) onExit();
                  else router.push('/');
                }}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 font-bold hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handlePasswordSubmit}
                className="flex-1 py-2.5 rounded-xl bg-blue-500 text-white font-bold hover:bg-blue-600 transition-colors shadow-lg shadow-blue-500/30"
              >
                Unlock
              </button>
            </div>
          </div>

          {showKeyboard && (
            <VirtualKeyboard
              onInput={handlePasswordInput}
              onDelete={handlePasswordDelete}
              onEnter={handlePasswordSubmit}
              onClose={() => setShowKeyboard(false)}
              mode="full"
            />
          )}
        </div>
      )}

      <div className="flex justify-between items-center mb-4 px-1">
        <h3 className="text-sm font-bold text-slate-700">Room #{roomId}</h3>
        <button
          onClick={onExit ? onExit : () => router.push('/')}
          className="text-xs text-blue-500 hover:text-blue-600 font-medium"
        >
          Exit Room
        </button>
      </div>

      {errorHeader && (
        <div className="mb-4 bg-red-50 text-red-500 text-xs py-2 px-4 rounded-lg inline-block animate-fade-in">
          {errorHeader}
        </div>
      )}

      <div className="space-y-3">
        {isLoading && !fileList && (
          <div className="text-center py-8 text-gray-400 text-sm">Loading...</div>
        )}

        {fileList && fileList.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">No files in this room</div>
        ) : (
          fileList?.map((file, idx) => (
            <div key={idx} className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm flex flex-col gap-2">
              <div className="flex items-center gap-4 w-full">
                <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100 shrink-0">
                  <FileIcon name={file.filename} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center mb-1">
                    <h4 className="text-sm font-bold text-slate-700 truncate">{file.filename}</h4>
                    <span className="text-xs text-slate-400 shrink-0 ml-2">{formatBytes(file.originalFileSize)}</span>
                  </div>

                  {downloadingFile === file.filename ? (
                    <div className="mt-2">
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-blue-500 mt-1 text-right">{Math.round(progress)}%</p>
                    </div>
                  ) : (
                    // Info: (20260113 - Luphia) Hide download button for media files
                    !isMedia(file.filename) && (
                      <button
                        onClick={() => handleDownload(file)}
                        className="w-full mt-2 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-500 hover:bg-blue-100 transition-colors flex items-center justify-center gap-2"
                      >
                        <DownloadIcon /> Download
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* Info: (20260113 - Luphia) Preview Area */}
              <div className="w-full flex justify-center">
                {renderPreview(file)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
