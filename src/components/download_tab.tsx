import { useState } from 'react';
import { useRouter } from 'next/navigation';
import VirtualKeyboard from '@/components/virtual_keyboard';

export default function DownloadTab() {
  const router = useRouter();
  const [roomId, setRoomId] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Info: (20260113 - Luphia) Keyboard state
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [activeInput, setActiveInput] = useState<'room' | 'password'>('room');

  const handleKeyboardInput = (char: string) => {
    if (activeInput === 'room') {
      if (roomId.length < 6) setRoomId(prev => prev + char);
    } else {
      setRoomPassword(prev => prev + char);
    }
  };

  const handleKeyboardDelete = () => {
    if (activeInput === 'room') {
      setRoomId(prev => prev.slice(0, -1));
    } else {
      setRoomPassword(prev => prev.slice(0, -1));
    }
  };

  const handleEntry = () => {
    if (roomId.length !== 6) return;
    setIsLoading(true);

    // Info: (20260113 - Luphia) Redirect to room page
    // Include password if provided (removed in previous step, but code might have leftovers, checking content)
    let url = `/room/${roomId}`;
    if (roomPassword) {
      url += `?pwd=${encodeURIComponent(roomPassword)}`;
    }

    router.push(url);
    setIsLoading(false);
  };

  return (
    <div className="text-center py-6">
      <p className="text-slate-400 mb-6 font-mono text-xs uppercase tracking-widest">Enter 6-digit Room Number</p>

      <div className="relative max-w-[200px] mx-auto mb-6">
        <input
          type="text"
          maxLength={6}
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onFocus={() => { setShowKeyboard(true); setActiveInput('room'); }}
          placeholder="000000"
          inputMode="none"
          aria-label="Room ID input"
          className="w-full px-4 py-4 bg-black/20 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-transparent transition-all font-mono text-center text-2xl tracking-[0.5em] text-white placeholder:text-slate-700 placeholder:tracking-widest shadow-inner shadow-black/20"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleEntry();
          }}
        />
      </div>

      <button
        onClick={handleEntry}
        disabled={isLoading || roomId.length !== 6}
        className="w-full px-6 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl font-bold uppercase tracking-wider text-sm transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-blue-500/40 active:scale-[0.98]"
      >
        {isLoading ? 'Accessing...' : 'Enter Room'}
      </button>

      {showKeyboard && (
        <VirtualKeyboard
          onInput={handleKeyboardInput}
          onDelete={handleKeyboardDelete}
          onEnter={handleEntry}
          onClose={() => setShowKeyboard(false)}
          mode={activeInput === 'room' ? 'numeric' : 'full'}
          position="fixed"
          value={roomId}
          label="Room ID"
        />
      )}
    </div>
  );
}
