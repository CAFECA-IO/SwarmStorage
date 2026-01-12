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
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4 font-sans text-slate-800">
      <div className="bg-white rounded-3xl shadow-xl w-full max-w-md overflow-hidden p-6 pb-8 relative">



        {/* Info: (20260113 - Luphia) Tabs */}
        <div className="flex p-1 gap-1 bg-slate-100 rounded-2xl mb-6 mt-6">
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

        {/* Info: (20260113 - Luphia) Content */}
        <div>
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
