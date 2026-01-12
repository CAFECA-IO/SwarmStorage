import { useState, useEffect } from 'react';
import VirtualKeyboard from '@/components/virtual_keyboard';
import { LockIcon, XIcon, TrashIcon } from '@/components/icons';
import ConfirmDialog from '@/components/confirm_dialog';

interface IRoomPasswordSetterProps {
  roomNumber: string;
}

export default function RoomPasswordSetter({ roomNumber }: IRoomPasswordSetterProps) {
  const [password, setPassword] = useState('');
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    const checkStatus = async () => {
      if (!roomNumber) return;
      try {
        const res = await fetch(`/api/v1/room/${roomNumber}/password`);
        const data = await res.json();
        if (data.code === 'OK') {
          setIsLocked(data.payload.hasPassword);
        }
      } catch (err) {
        console.error(err);
      }
    };
    checkStatus();
  }, [roomNumber]);

  const handleSetPassword = async () => {
    if (!roomNumber || !password) return;
    try {
      await fetch(`/api/v1/room/${roomNumber}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      console.log('Password set successfully');
      setIsLocked(true);
      setShowPasswordInput(false);
      setPassword('');
      setShowKeyboard(false);
    } catch (err) {
      console.error('Failed to set password', err);
    }
  };

  const handleRemovePassword = async () => {
    if (!roomNumber) return;

    try {
      await fetch(`/api/v1/room/${roomNumber}/password`, {
        method: 'DELETE',
      });
      setIsLocked(false);
      setShowPasswordInput(false);
      setPassword('');
      setShowKeyboard(false);
    } catch (err) {
      console.error('Failed to remove password', err);
    }
    setShowConfirm(false);
  };

  const handleKeyboardInput = (char: string) => {
    setPassword(prev => prev + char);
  };

  const handleKeyboardDelete = () => {
    setPassword(prev => prev.slice(0, -1));
  };

  return (
    <>
      <div className="relative h-9 flex items-center">
        {/* Info: (20260113 - Luphia) Toggle Button */}
        <button
          onClick={() => setShowPasswordInput(true)}
          className={`
            flex items-center gap-2 px-3 py-1.5 rounded-full
            text-xs font-bold tracking-wide transition-all duration-300
            ${showPasswordInput
              ? 'opacity-0 pointer-events-none translate-x-4 absolute'
              : isLocked
                ? 'bg-emerald-50 text-emerald-600 shadow-sm border border-emerald-100 opacity-100 translate-x-0'
                : 'bg-white text-slate-500 hover:text-blue-500 hover:bg-blue-50 shadow-sm border border-slate-100 opacity-100 translate-x-0'
            }
          `}
        >
          <LockIcon />
          <span>{isLocked ? 'Locked' : 'Set Password'}</span>
        </button>

        {/* Info: (20260113 - Luphia) Input Field */}
        <div
          className={`
             absolute left-0 flex items-center gap-1 transition-all duration-300
             ${showPasswordInput
              ? 'opacity-100 translate-x-0'
              : 'opacity-0 pointer-events-none -translate-x-4'
            }
           `}
        >
          <div className="flex items-center bg-white rounded-full border border-slate-200 shadow-sm pl-3 p-1">
            <div className="text-slate-400"><LockIcon /></div>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setShowKeyboard(true)}
              placeholder="******"
              className="w-24 px-2 py-1 text-xs bg-transparent outline-none font-mono text-slate-600 tracking-widest placeholder:tracking-normal"
              aria-label="Room Password"
            />
            <button
              onClick={handleSetPassword}
              className="bg-blue-500 text-white rounded-full px-4 py-1.5 text-xs font-bold hover:bg-blue-600 transition-colors shadow-blue-500/20 shadow-md"
            >
              {isLocked ? 'Update' : 'Save'}
            </button>

            {isLocked && (
              <button
                onClick={() => setShowConfirm(true)}
                className="ml-1 p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                title="Remove Password"
              >
                <TrashIcon />
              </button>
            )}

            <button
              onClick={() => {
                setShowPasswordInput(false);
                setShowKeyboard(false);
              }}
              className="ml-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors"
            >
              <XIcon />
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={showConfirm}
        title="Remove Password?"
        description="This will allow anyone with the Room ID to access the files."
        confirmText="Remove"
        onConfirm={handleRemovePassword}
        onCancel={() => setShowConfirm(false)}
        type="danger"
      />

      {showKeyboard && (
        <VirtualKeyboard
          onInput={handleKeyboardInput}
          onDelete={handleKeyboardDelete}
          onEnter={handleSetPassword}
          onClose={() => setShowKeyboard(false)}
          mode="full"
          position="relative"
        />
      )}
    </>
  );
}
