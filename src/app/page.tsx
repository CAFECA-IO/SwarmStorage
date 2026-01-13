'use client';

import { useState, useEffect } from 'react';
import UploadTab from '@/components/upload_tab';
import DownloadTab from '@/components/download_tab';

export default function Page() {
  const [activeTab, setActiveTab] = useState<'upload' | 'download'>('upload');
  const [roomNumber, setRoomNumber] = useState<string | null>(null);

  // Info: (20250113 - Luphia) Auto-create room on startup
  useEffect(() => {
    const createRoom = async () => {
      try {
        const res = await fetch('/api/v1/room', { method: 'POST' });
        const data = await res.json();
        if (data.code === 'OK') {
          console.log(`[Auto-Room] Created room: ${data.payload.roomNumber}`);
          setRoomNumber(data.payload.roomNumber);
        } else {
          console.error('[Auto-Room] Failed to create room:', data.message);
        }
      } catch (err) {
        console.error('[Auto-Room] Error:', err);
      }
    };
    createRoom();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 relative flex p-4 font-sans text-slate-100 overflow-x-hidden overflow-y-auto">
      {/* Info: (20260113 - Luphia) Background Grid & Accents */}
      <div className="fixed inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none"></div>
      <div className="fixed top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="fixed bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-indigo-500/10 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="bg-white/5 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-2xl shadow-black/50 w-full max-w-md overflow-hidden p-6 pb-8 relative z-10 m-auto">

        <div className="mb-6 text-center">
          {/* Info: (20260113 - Luphia) Header */}
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 mb-2">
            Drop Here
          </h1>

          {/* Info: (20260113 - Luphia) Requested Description */}
          <p className="font-mono text-[10px] tracking-[0.2em] text-blue-300/70 uppercase animate-pulse">
            share your data sell your files
          </p>
        </div>

        {/* Info: (20260113 - Luphia) Tabs */}
        <div className="flex p-1 gap-1 bg-black/20 rounded-2xl mb-6 border border-white/5">
          <button
            onClick={() => setActiveTab('upload')}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-300 ${activeTab === 'upload'
              ? 'bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/20'
              : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
              }`}
          >
            Upload
          </button>
          <button
            onClick={() => setActiveTab('download')}
            className={`flex-1 py-2.5 text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-300 ${activeTab === 'download'
              ? 'bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/20'
              : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'
              }`}
          >
            Download
          </button>
        </div>

        {/* Info: (20260113 - Luphia) Content */}
        <div className="bg-white/5 rounded-2xl p-2 border border-white/5">
          {activeTab === 'upload' ? (
            <UploadTab roomNumber={roomNumber} />
          ) : (
            <DownloadTab />
          )}
        </div>
      </div>
    </div>
  );
}
