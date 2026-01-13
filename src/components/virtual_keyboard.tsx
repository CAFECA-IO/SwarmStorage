// Info: (20260113 - Luphia) Virtual Keyboard
import { useState, useEffect } from 'react';
import { XIcon } from '@/components/icons';

interface IVirtualKeyboardProps {
  onInput: (char: string) => void;
  onDelete: () => void;
  onEnter?: () => void;
  onClose: () => void;
  mode?: 'numeric' | 'full';
  position?: 'fixed' | 'relative' | 'absolute';
  value?: string;
  label?: string; // Info: (20260113 - Luphia) Label for the input (e.g. "Room ID")
}

// Info: (20260113 - Luphia) Input Preview Component
const InputPreview = ({ value, label }: { value?: string, label?: string }) => (
  <div className="w-full bg-slate-950/80 backdrop-blur-md border-b border-white/10 p-3 mb-2 flex flex-col items-center justify-center animate-fade-in user-select-none">
    {label && <span className="text-[10px] text-slate-400 uppercase tracking-widest mb-1">{label}</span>}
    <span className="text-2xl font-mono text-white tracking-[0.2em] font-bold h-8 min-w-[20px]">
      {value || <span className="text-slate-700 opacity-50">_</span>}
    </span>
  </div>
);

export default function VirtualKeyboard({
  onInput,
  onDelete,
  onEnter,
  onClose,
  mode = 'full',
  position = 'fixed',
  value,
  label
}: IVirtualKeyboardProps) {
  const [isShift, setIsShift] = useState(false);

  useEffect(() => {
    // Info: (20260113 - Luphia) Ensure the input is visible when keyboard opens (don't block it)
    const activeInfo = document.activeElement;
    if (activeInfo && activeInfo.tagName === 'INPUT') {
      setTimeout(() => {
        activeInfo.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  }, []);

  // Info: (20260113 - Luphia) Full Layout (QWERTY)
  const row1 = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  const row2 = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
  const row3 = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
  const row4 = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];

  const handleKeyClick = (key: string) => {
    onInput(isShift ? key.toUpperCase() : key);
  };

  if (mode === 'numeric') {
    const containerClasses = position === 'fixed'
      ? "fixed bottom-0 left-0 right-0 bg-slate-900/90 backdrop-blur-xl border-t border-white/10 pb-8 shadow-2xl z-50 animate-slide-up"
      : "w-full bg-slate-900/50 border-t border-white/10 p-4 rounded-xl shadow-lg mt-4 animate-fade-in";

    return (
      <div className={containerClasses}>
        {/* Info: (20260113 - Luphia) Show Magnified Input if value is provided */}
        {position === 'fixed' && <InputPreview value={value} label={label} />}

        <div className="max-w-xs mx-auto px-4 pt-2">

          <div className="flex justify-end mb-2">
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-white transition-colors">
              <XIcon />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
              <button
                key={key}
                onClick={() => handleKeyClick(key)}
                className="bg-white/10 hover:bg-white/20 rounded-xl shadow-sm p-4 text-xl font-bold text-white active:bg-blue-600/50 active:scale-95 transition-all outline-none"
              >
                {key}
              </button>
            ))}
            <button
              onClick={onDelete}
              className="bg-red-500/10 hover:bg-red-500/20 rounded-xl shadow-sm p-4 text-xl font-bold text-red-400 active:bg-red-500/30 active:scale-95 transition-all flex items-center justify-center outline-none"
            >
              ⌫
            </button>
            <button
              onClick={() => handleKeyClick('0')}
              className="bg-white/10 hover:bg-white/20 rounded-xl shadow-sm p-4 text-xl font-bold text-white active:bg-blue-600/50 active:scale-95 transition-all outline-none"
            >
              0
            </button>
            {onEnter && (
              <button
                onClick={onEnter}
                className="bg-blue-600 hover:bg-blue-500 rounded-xl shadow-lg shadow-blue-500/20 p-4 text-xl font-bold text-white active:bg-blue-700 active:scale-95 transition-all flex items-center justify-center outline-none"
              >
                ↵
              </button>
            )}
            {!onEnter && <div className="col-span-1"></div>}
          </div>
        </div>
      </div>
    );
  }

  // Info: (20260113 - Luphia) Full Mode
  const containerClasses = position === 'fixed'
    ? "fixed bottom-0 left-0 right-0 bg-slate-900/90 backdrop-blur-xl border-t border-white/10 shadow-2xl z-50 animate-slide-up select-none pb-8"
    : "w-full bg-slate-900/50 border-t border-white/10 p-2 rounded-xl shadow-lg mt-4 animate-fade-in select-none";

  return (
    <div className={containerClasses}>
      {/* Info: (20260113 - Luphia) Show Magnified Input if value is provided */}
      {position === 'fixed' && <InputPreview value={value} label={label} />}

      <div className="max-w-2xl mx-auto flex flex-col gap-1.5 p-2 pt-0">
        <div className="flex justify-between items-center px-1 mb-1">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Virtual Keyboard</span>
          <button onClick={onClose} className="p-1 text-slate-500 hover:text-white transition-colors">
            <XIcon />
          </button>
        </div>

        {/* Info: (20260113 - Luphia) Row 1 */}
        <div className="flex justify-center gap-1">
          {row1.map(key => (
            <KeyButton key={key} label={key} onClick={() => handleKeyClick(key)} />
          ))}
        </div>

        {/* Info: (20260113 - Luphia) Row 2 */}
        <div className="flex justify-center gap-1">
          {row2.map(key => (
            <KeyButton key={key} label={isShift ? key.toUpperCase() : key} onClick={() => handleKeyClick(key)} />
          ))}
        </div>

        {/* Info: (20260113 - Luphia) Row 3 */}
        <div className="flex justify-center gap-1">
          <div className="w-2 sm:w-4" /> {/* Info: (20260113 - Luphia) Spacer */}
          {row3.map(key => (
            <KeyButton key={key} label={isShift ? key.toUpperCase() : key} onClick={() => handleKeyClick(key)} />
          ))}
          <div className="w-2 sm:w-4" /> {/* Info: (20260113 - Luphia) Spacer */}
        </div>

        {/* Info: (20260113 - Luphia) Row 4 */}
        <div className="flex justify-center gap-1">
          <button
            onClick={() => setIsShift(!isShift)}
            className={`px-3 py-2 rounded-lg text-sm font-bold shadow-sm transition-all min-w-[36px] ${isShift ? 'bg-blue-600 text-white shadow-blue-500/30' : 'bg-white/10 text-slate-400 hover:text-white hover:bg-white/20'}`}
          >
            ⇧
          </button>

          {row4.map(key => (
            <KeyButton key={key} label={isShift ? key.toUpperCase() : key} onClick={() => handleKeyClick(key)} />
          ))}

          <button
            onClick={onDelete}
            className="px-3 py-2 bg-white/10 hover:bg-red-500/20 rounded-lg text-sm font-bold text-slate-400 hover:text-red-400 shadow-sm active:bg-white/20 transition-all min-w-[36px]"
          >
            ⌫
          </button>

          {onEnter && (
            <button
              onClick={onEnter}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-bold text-white shadow-lg shadow-blue-500/20 active:bg-blue-700 transition-all min-w-[48px]"
            >
              ↵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="flex-1 bg-white/10 hover:bg-white/20 rounded-md sm:rounded-lg shadow-sm py-2 sm:py-2.5 text-xs sm:text-sm font-bold text-slate-200 active:bg-blue-600/50 active:scale-95 transition-all min-w-[20px] max-w-[40px] flex justify-center items-center outline-none select-none"
    >
      {label}
    </button>
  );
}
