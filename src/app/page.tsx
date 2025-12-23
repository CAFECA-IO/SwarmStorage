'use client';

import { useState, useRef, ChangeEvent, DragEvent, KeyboardEvent } from 'react';

// Types
interface IFileUploadState {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'completed' | 'error';
  cid?: string;
  error?: string;
}

// Icons
const CloudUploadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500 mb-4">
    <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
    <path d="M12 12v9" />
    <path d="m16 16-4-4-4 4" />
  </svg>
);

const FileIcon = ({ name }: { name: string }) => {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (ext === 'fig') {
    // Figma-like Icon (Purple)
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500">
        <path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5z" />
        <path d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2z" />
        <path d="M12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0z" />
        <path d="M5 19.5A3.5 3.5 0 0 1 8.5 23H12v-3.5a3.5 3.5 0 1 1-7 0z" />
        <path d="M5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z" />
      </svg>
    );
  }

  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    // Excel-like Icon (Green)
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h8" />
        <path d="M10 9h4" />
      </svg>
    );
  }

  if (['pdf'].includes(ext)) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M10 9H8" />
      </svg>
    );
  }

  // Default Blue
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
};

const XIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 hover:text-gray-600">
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const TrashIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 hover:text-red-500 transition-colors">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const DownloadIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 hover:text-blue-500 transition-colors">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </svg>
);

export default function Page() {
  const [activeTab, setActiveTab] = useState<'upload' | 'download'>('upload');
  const [files, setFiles] = useState<IFileUploadState[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper to format bytes
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(0)) + ' ' + sizes[i];
  };

  const uploadFile = (fileItem: IFileUploadState) => {
    const formData = new FormData();
    formData.append('file', fileItem.file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/file', true);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percentComplete = (event.loaded / event.total) * 100;
        setFiles(prev => prev.map(f =>
          f.id === fileItem.id ? { ...f, progress: percentComplete } : f
        ));
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const response = JSON.parse(xhr.responseText);
          setFiles(prev => prev.map(f =>
            f.id === fileItem.id ? {
              ...f,
              status: 'completed',
              progress: 100,
              cid: response.payload.hash
            } : f
          ));
        } catch {
          setFiles(prev => prev.map(f =>
            f.id === fileItem.id ? { ...f, status: 'error', error: 'Invalid response' } : f
          ));
        }
      } else {
        setFiles(prev => prev.map(f =>
          f.id === fileItem.id ? { ...f, status: 'error', error: 'Upload failed' } : f
        ));
      }
    };

    xhr.onerror = () => {
      setFiles(prev => prev.map(f =>
        f.id === fileItem.id ? { ...f, status: 'error', error: 'Network error' } : f
      ));
    };

    xhr.send(formData);
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
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 font-sans text-slate-800">
      <div className="bg-white rounded-3xl shadow-xl w-full max-w-md overflow-hidden p-6 pb-8">

        {/* Tabs */}
        <div className="flex p-1 gap-1 bg-slate-100 rounded-2xl mb-6">
          <button
            onClick={() => setActiveTab('upload')}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 ${activeTab === 'upload'
              ? 'bg-white shadow-sm text-slate-900'
              : 'text-slate-500 hover:text-slate-700'
              }`}
          >
            Upload
          </button>
          <button
            onClick={() => setActiveTab('download')}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200 ${activeTab === 'download'
              ? 'bg-white shadow-sm text-slate-900'
              : 'text-slate-500 hover:text-slate-700'
              }`}
          >
            Download
          </button>
        </div>

        {/* Content */}
        <div>

          {activeTab === 'upload' ? (
            <>
              {/* Drop Zone */}
              <div
                role="button"
                tabIndex={0}
                className={`
                            border-2 border-dashed rounded-3xl p-8 mb-4 text-center cursor-pointer transition-colors duration-200
                            flex flex-col items-center justify-center min-h-[220px]
                            ${dragActive ? 'border-blue-500 bg-blue-50' : 'border-blue-300 hover:border-blue-400 bg-sky-50/50'}
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
                <div className="bg-white p-3 rounded-full shadow-sm mb-4">
                  <CloudUploadIcon />
                </div>
                <p className="text-slate-600 font-medium mb-1">Drag & drop or click to</p>
                <p className="text-slate-600 font-medium">choose files</p>
              </div>

              <div className="flex justify-between text-xs text-gray-400 px-1 mb-6 font-medium">
                <span>Supported formats: XLS, XLSX</span>
                <span>Max: 25MB</span>
              </div>

              {/* File List */}
              <div className="space-y-3">
                {files.map(file => (
                  <div key={file.id} className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm relative group">
                    <div className="flex items-start gap-4">
                      <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                        <FileIcon name={file.file.name} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start mb-1.5">
                          <h4 className="text-sm font-bold text-slate-700 truncate pr-4">{file.file.name}</h4>
                          {file.status !== 'uploading' && (
                            <button
                              onClick={() => removeFile(file.id)}
                              className="text-gray-300 hover:text-gray-500"
                              aria-label="Cancel upload"
                            >
                              <XIcon />
                            </button>
                          )}
                        </div>

                        {file.status === 'uploading' ? (
                          <div>
                            <div className="flex justify-between text-xs text-gray-400 mb-1.5 font-medium">
                              <span>{formatBytes(file.file.size)}</span>
                              <span>{Math.round(file.progress)}%</span>
                            </div>
                            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out"
                                style={{ width: `${file.progress}%` }}
                              />
                            </div>
                          </div>
                        ) : file.status === 'completed' ? (
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-xs text-slate-400 font-medium">{formatBytes(file.file.size)}</span>
                            <div className="flex gap-2">
                              <a
                                href={`/api/v1/file/${file.cid}?filename=${encodeURIComponent(file.file.name)}`}
                                download
                                className="p-1.5 rounded-lg text-gray-400 hover:text-blue-500 hover:bg-blue-50 transition-colors"
                                title="Download"
                                aria-label="Download file"
                              >
                                <DownloadIcon />
                              </a>
                              <button
                                onClick={() => removeFile(file.id)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                title="Remove"
                                aria-label="Remove file"
                              >
                                <TrashIcon />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs text-red-500 mt-1 font-medium">
                            Upload failed
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-400 mb-4 font-medium">Enter a File ID or CID to download</p>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Enter CID..."
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = e.currentTarget.value;
                      if (val) window.location.href = `/api/v1/file/${val}`;
                    }
                  }}
                  aria-label="Enter CID"
                />
                <div className="absolute right-3 top-3 text-gray-400">
                  <DownloadIcon />
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
