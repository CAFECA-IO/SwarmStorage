// Info: (20260113 - Luphia) Room Number Display
interface IRoomNumberDisplayProps {
  roomNumber: string;
}

export default function RoomNumberDisplay({ roomNumber }: IRoomNumberDisplayProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="bg-black/20 backdrop-blur-sm border border-white/10 rounded-lg px-3 py-1.5 flex items-center h-9 shadow-inner shadow-black/20">
        <span className="text-[10px] font-mono text-slate-500 mr-2 uppercase tracking-widest">Room</span>
        <span className="text-sm font-bold text-blue-400 font-mono tracking-[0.2em] shadow-blue-500/50 drop-shadow-[0_0_8px_rgba(59,130,246,0.3)]">#{roomNumber}</span>
      </div>
    </div>
  );
}
