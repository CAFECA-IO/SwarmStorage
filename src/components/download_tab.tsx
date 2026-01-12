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
    <div className="text-center py-12">
      <p className="text-gray-400 mb-4 font-medium">Enter 6-digit Room Number</p>

      <div className="relative max-w-[200px] mx-auto mb-4">
        <input
          type="text"
          maxLength={6}
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onFocus={() => { setShowKeyboard(true); setActiveInput('room'); }}
          placeholder="Room ID"
          aria-label="Room ID input"
          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all font-mono text-center text-lg tracking-widest text-slate-700 placeholder:text-base placeholder:tracking-normal placeholder:font-sans"
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleEntry();
          }}
        />
      </div>

      <button
        onClick={handleEntry}
        disabled={isLoading || roomId.length !== 6}
        className="mt-6 px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? 'Loading...' : 'View Files'}
      </button>

      {showKeyboard && (
        <VirtualKeyboard
          onInput={handleKeyboardInput}
          onDelete={handleKeyboardDelete}
          onEnter={handleEntry}
          onClose={() => setShowKeyboard(false)}
          mode={activeInput === 'room' ? 'numeric' : 'full'}
          position="relative"
        />
      )}
    </div>
  );
}
