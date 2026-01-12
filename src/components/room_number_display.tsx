// Info: (20260113 - Luphia) Room Number Display
interface IRoomNumberDisplayProps {
  roomNumber: string;
}

export default function RoomNumberDisplay({ roomNumber }: IRoomNumberDisplayProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="bg-slate-100 rounded-lg px-3 py-1.5 flex items-center h-9">
        <span className="text-xs font-mono text-slate-400 mr-2">Room</span>
        <span className="text-sm font-bold text-slate-700 font-mono tracking-wider">#{roomNumber}</span>
      </div>
    </div>
  );
}
