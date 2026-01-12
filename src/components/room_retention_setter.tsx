import { useState, useEffect, useCallback, useRef } from 'react';
import { ClockIcon } from '@/components/icons';

interface IRoomRetentionSetterProps {
  roomNumber: string;
}

export default function RoomRetentionSetter({ roomNumber }: IRoomRetentionSetterProps) {
  const [retention, setRetention] = useState<number>(10); // Default 10m

  // Info: (20260113 - Luphia) Check if retention is initialized
  const initialized = useRef(false);

  const handleSetRetention = useCallback(async (minutes: number, silent = false) => {
    if (!roomNumber) return;
    try {
      await fetch(`/api/v1/room/${roomNumber}/expiration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes })
      });
      if (!silent) console.log(`Retention set to ${minutes} minutes`);
      setRetention(minutes);
    } catch (err) {
      if (!silent) console.error('Failed to set retention');
      console.error(err);
    }
  }, [roomNumber]);

  // Info: (20260113 - Luphia) Set default retention on mount
  useEffect(() => {
    const initRetention = async () => {
      if (roomNumber && !initialized.current) {
        initialized.current = true;
        try {
          await fetch(`/api/v1/room/${roomNumber}/expiration`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ minutes: 10 })
          });
          // Info: (20250113 - Luphia) Default is already 10 in state, so no need to setRetention
        } catch (err) {
          console.error(err);
        }
      }
    };
    initRetention();
  }, [roomNumber]);

  return (
    <div className="flex items-center gap-3 bg-white border border-slate-100 rounded-full px-4 py-1.5 shadow-sm h-9">
      <div className="text-slate-400 flex items-center">
        <ClockIcon />
      </div>
      <div className="h-4 w-px bg-slate-100"></div>
      <div className="flex items-center gap-1">
        {[10, 60, 1440].map((m) => (
          <button
            key={m}
            onClick={() => handleSetRetention(m)}
            className={`
                text-xs font-bold px-3 py-1 rounded-full transition-all duration-200
                ${retention === m
                ? 'bg-blue-500 text-white shadow-blue-500/20 shadow-md scale-105'
                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'}
              `}
          >
            {m === 10 ? '10m' : m === 60 ? '1h' : '1d'}
          </button>
        ))}
      </div>
    </div>
  );
}
