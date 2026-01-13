import { useState, useRef, ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { uploadFile as uploadFileLib, downloadFile, ILariaMetadata } from '@/lib/file_operator';
import { formatBytes } from '@/lib/utils';
import { CloudUploadIcon, FileIcon, XIcon, TrashIcon, DownloadIcon } from '@/components/icons';
import RoomPasswordSetter from '@/components/room_password_setter';
import RoomRetentionSetter from '@/components/room_retention_setter';
import RoomNumberDisplay from '@/components/room_number_display';

// Info: (20260113 - Luphia) Types
interface IFileUploadState {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  cid?: string;
  error?: string;
  isDownloading?: boolean;
  downloadProgress?: number;
}


// Info: (20260113 - Luphia) Animation Particles
const PARTICLES = [
  { left: '20%', delay: '0s', duration: '1s', char: '1' },
  { left: '30%', delay: '0.4s', duration: '1.2s', char: '0' },
  { left: '40%', delay: '0.1s', duration: '0.8s', char: '1' },
  { left: '50%', delay: '0.5s', duration: '1.3s', char: '0' },
  { left: '60%', delay: '0.2s', duration: '0.9s', char: '1' },
  { left: '70%', delay: '0.6s', duration: '1.1s', char: '0' },
  { left: '80%', delay: '0.3s', duration: '1.4s', char: '1' },
  { left: '45%', delay: '0.7s', duration: '1s', char: '0' },
  { left: '55%', delay: '0.15s', duration: '1.2s', char: '1' },
];

interface IUploadTabProps {
  roomNumber: string | null;
}

export default function UploadTab({ roomNumber }: IUploadTabProps) {
  const [files, setFiles] = useState<IFileUploadState[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = (fileItem: IFileUploadState) => {
    uploadFileLib(fileItem.file, {
      onProgress: (progress: number) => {
        setFiles(prev => prev.map(f =>
          f.id === fileItem.id ? { ...f, progress } : f
        ));
      },
      onSuccess: async (cid: string, metadata?: ILariaMetadata) => {
        setFiles(prev => prev.map(f =>
          f.id === fileItem.id ? {
            ...f,
            status: 'completed',
            progress: 100,
            cid
          } : f
        ));

        // Info: (20250113 - Luphia) Upload metadata to room
        if (roomNumber && metadata) {
          try {
            await fetch(`/api/v1/room/${roomNumber}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(metadata)
            });
            console.log(`[Room] Uploaded metadata for ${fileItem.file.name} to room ${roomNumber}`);
          } catch (err) {
            console.error('[Room] Failed to upload metadata:', err);
          }
        }
      },
      onError: (error: string) => {
        setFiles(prev => prev.map(f =>
          f.id === fileItem.id ? { ...f, status: 'error', error } : f
        ));
      }
    });
  };

  const handleFiles = (newFiles: File[]) => {
    const newUploads: IFileUploadState[] = newFiles.map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      progress: 0,
      status: 'uploading'
    }));

    setFiles(prev => [...newUploads, ...prev]);

    newUploads.forEach(uploadFile);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      fileInputRef.current?.click();
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
    // Info: (20260113 - Luphia) Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };


  return (
    <>
      {/* Info: (20260113 - Luphia) Room Indicator & Settings */}
      {roomNumber && (
        <div className="flex flex-col gap-4 px-2 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <RoomNumberDisplay roomNumber={roomNumber} />
            <RoomPasswordSetter roomNumber={roomNumber} />
          </div>
          <RoomRetentionSetter roomNumber={roomNumber} />
        </div>
      )}

      {/* Info: (20260113 - Luphia) Drop Zone */}
      <div
        role="button"
        tabIndex={0}
        className={`
                    border-2 border-dashed rounded-3xl p-8 mb-4 text-center cursor-pointer 
                    transition-all duration-300 ease-in-out transform  hover:shadow-lg group
                    flex flex-col items-center justify-center min-h-[220px] relative overflow-hidden
                    ${dragActive
            ? 'border-blue-500/50 bg-blue-500/10 scale-[1.02] shadow-blue-500/10'
            : 'border-white/10 hover:border-blue-500/30 bg-black/20 hover:bg-black/30'}
                `}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={onKeyDown}
        aria-label="Upload file dropzone"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleChange}
          aria-label="File upload"
        />

        {/* Info: (20260113 - Luphia) Icon Container with Particles */}
        <div className="relative bg-white/5 backdrop-blur-md w-24 h-24 flex items-center justify-center rounded-full shadow-lg shadow-black/20 mb-4 transition-transform duration-300 group-hover:scale-110 group-hover:-translate-y-1 overflow-visible border border-white/10">
          <CloudUploadIcon className="text-blue-400 w-10 h-10" />

          {/* Info: (20260113 - Luphia) Binary Particles */}
          <div className="absolute inset-0 flex justify-center items-end opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none">
            {PARTICLES.map((p, i) => (
              <span
                key={i}
                className="absolute text-[10px] font-mono font-bold text-blue-400 animate-float"
                style={{
                  left: p.left,
                  bottom: '0',
                  animationDelay: p.delay,
                  animationDuration: p.duration,
                  textShadow: '0 0 5px rgba(59, 130, 246, 0.5)'
                }}
              >
                {p.char}
              </span>
            ))}
          </div>
        </div>

        <p className="text-slate-300 font-medium mb-1">Drag & drop or click to</p>
        <p className="text-slate-400 text-sm">choose files</p>
      </div>

      <div className="flex justify-between text-[10px] text-slate-500 px-1 mb-6 font-mono tracking-wider uppercase">
        <span>Supported Every File Formats</span>
        <span>Max: 4GB</span>
      </div>

      {/* Info: (20260113 - Luphia) File List */}
      <div className="space-y-3">
        {files.map(file => (
          <div key={file.id} className="bg-black/20 backdrop-blur-sm rounded-2xl p-4 border border-white/5 shadow-sm relative group">
            <div className="flex items-start gap-4">
              <div className="bg-white/5 p-2.5 rounded-xl border border-white/5">
                <FileIcon name={file.file.name} className="text-slate-300" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-start mb-1.5">
                  <h4 className="text-sm font-bold text-slate-200 truncate pr-4">{file.file.name}</h4>
                  {file.status !== 'uploading' && (
                    <button
                      onClick={() => removeFile(file.id)}
                      className="text-slate-500 hover:text-red-400 transition-colors"
                      aria-label="Cancel upload"
                    >
                      <XIcon />
                    </button>
                  )}
                </div>

                {file.status === 'uploading' ? (
                  <div>
                    <div className="flex justify-between text-xs text-slate-400 mb-1.5 font-medium font-mono">
                      <span>{formatBytes(file.file.size)}</span>
                      <span>{Math.round(file.progress)}%</span>
                    </div>
                    <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                        style={{ width: `${file.progress}%` }}
                      />
                    </div>
                  </div>
                ) : file.status === 'completed' ? (
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-500 font-mono">{formatBytes(file.file.size)}</span>
                    <div className="flex gap-2 items-center">
                      {file.isDownloading ? (
                        <span className="text-xs text-blue-400 font-medium animate-pulse">
                          {Math.round(file.downloadProgress || 0)}%
                        </span>
                      ) : (
                        <button
                          onClick={() => {
                            if (file.cid) {
                              setFiles(prev => prev.map(f =>
                                f.id === file.id ? { ...f, isDownloading: true, downloadProgress: 0 } : f
                              ));
                              downloadFile(file.cid, {
                                onProgress: (progress: number) => {
                                  setFiles(prev => prev.map(f =>
                                    f.id === file.id ? { ...f, downloadProgress: progress } : f
                                  ));
                                },
                                onSuccess: (blob: Blob, filename: string) => {
                                  setFiles(prev => prev.map(f =>
                                    f.id === file.id ? { ...f, isDownloading: false, downloadProgress: 100 } : f
                                  ));
                                  const url = window.URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = filename;
                                  document.body.appendChild(a);
                                  a.click();
                                  window.URL.revokeObjectURL(url);
                                  document.body.removeChild(a);
                                },
                                onError: (error: string) => {
                                  setFiles(prev => prev.map(f =>
                                    f.id === file.id ? { ...f, isDownloading: false, downloadProgress: 0 } : f
                                  ));
                                  alert(`Download failed: ${error}`);
                                }
                              });
                            }
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
                          title="Download"
                          aria-label="Download file"
                        >
                          <DownloadIcon />
                        </button>
                      )}
                      <button
                        onClick={() => removeFile(file.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Remove"
                        aria-label="Remove file"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-red-400 mt-1 font-medium">
                    Upload failed
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
