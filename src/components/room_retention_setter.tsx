import { useState, useEffect, useCallback, useRef } from 'react';
import { ClockIcon, CoinIcon } from '@/components/icons';

interface IRoomRetentionSetterProps {
  roomNumber: string;
}

export default function RoomRetentionSetter({ roomNumber }: IRoomRetentionSetterProps) {
  const [retention, setRetention] = useState<number>(10); // Default 10m
  const [enablePaid, setEnablePaid] = useState(false);

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
    <div className="flex items-center gap-1 sm:gap-3 bg-black/20 backdrop-blur-sm border border-white/10 rounded-full px-2 sm:px-4 py-1.5 shadow-inner shadow-black/20 h-9">
      <div className="text-slate-500 flex items-center">
        <ClockIcon />
      </div>
      <div className="h-4 w-px bg-white/10"></div>
      <div className="flex items-center gap-1">
        {[10, 60, 1440].map((m) => (
          <button
            key={m}
            onClick={() => handleSetRetention(m)}
            className={`
                text-xs font-bold px-2 sm:px-3 py-1 rounded-full transition-all duration-200
                ${retention === m
                ? 'bg-blue-600 text-white shadow-[0_0_10px_rgba(37,99,235,0.4)] shadow-md scale-105'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'}
              `}
          >
            {m === 10 ? '10m' : m === 60 ? '1h' : '1d'}
          </button>
        ))}
      </div>
      <div className="h-4 w-px bg-white/10 mx-1"></div>

      {/* Info: (20260113 - Luphia) Paid Purchase Toggle */}
      <button
        onClick={() => setEnablePaid(!enablePaid)}
        className={`
          flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-full transition-all duration-300 border
          ${enablePaid
            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
            : 'bg-transparent text-slate-500 border-transparent hover:text-slate-300 hover:bg-white/5'}
        `}
        title="Allow paid access after expiration"
      >
        <CoinIcon className={enablePaid ? "text-emerald-400" : "text-slate-500"} />
        <span className="text-xs font-bold uppercase tracking-wider whitespace-nowrap">{enablePaid ? 'Paid' : 'Free'}</span>
      </button>
    </div>
  );
}
