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
}

export default function VirtualKeyboard({ onInput, onDelete, onEnter, onClose, mode = 'full', position = 'fixed' }: IVirtualKeyboardProps) {
  const [isShift, setIsShift] = useState(false);

  useEffect(() => {
    // Info: (20260113 - Luphia) Ensure the input is visible when keyboard opens (don't block it)
    const activeInfo = document.activeElement;
    if (activeInfo && activeInfo.tagName === 'INPUT') {
      setTimeout(() => {
        activeInfo.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
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
      ? "fixed bottom-0 left-0 right-0 bg-slate-100 border-t border-slate-200 p-4 shadow-xl z-50 animate-slide-up"
      : "w-full bg-slate-100 border-t border-slate-200 p-4 rounded-xl shadow-lg mt-4 animate-fade-in";

    return (
      <div className={containerClasses}>
        <div className="max-w-xs mx-auto">
          <div className="flex justify-end mb-2">
            <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-600">
              <XIcon />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => (
              <button
                key={key}
                onClick={() => handleKeyClick(key)}
                className="bg-white rounded-xl shadow-sm p-4 text-xl font-bold text-slate-600 active:bg-slate-50 active:scale-95 transition-all"
              >
                {key}
              </button>
            ))}
            <button
              onClick={onDelete}
              className="bg-red-50 rounded-xl shadow-sm p-4 text-xl font-bold text-red-500 active:bg-red-100 active:scale-95 transition-all flex items-center justify-center"
            >
              ⌫
            </button>
            <button
              onClick={() => handleKeyClick('0')}
              className="bg-white rounded-xl shadow-sm p-4 text-xl font-bold text-slate-600 active:bg-slate-50 active:scale-95 transition-all"
            >
              0
            </button>
            {onEnter && (
              <button
                onClick={onEnter}
                className="bg-blue-500 rounded-xl shadow-sm p-4 text-xl font-bold text-white active:bg-blue-600 active:scale-95 transition-all flex items-center justify-center"
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
    ? "fixed bottom-0 left-0 right-0 bg-slate-100 border-t border-slate-200 p-2 shadow-xl z-50 animate-slide-up select-none"
    : "w-full bg-slate-100 border-t border-slate-200 p-2 rounded-xl shadow-lg mt-4 animate-fade-in select-none";

  return (
    <div className={containerClasses}>
      <div className="max-w-2xl mx-auto flex flex-col gap-1.5 pb-safe">
        <div className="flex justify-between items-center px-1">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Virtual Keyboard</span>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
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
          <div className="w-4" /> {/* Info: (20260113 - Luphia) Spacer */}
          {row3.map(key => (
            <KeyButton key={key} label={isShift ? key.toUpperCase() : key} onClick={() => handleKeyClick(key)} />
          ))}
          <div className="w-4" /> {/* Info: (20260113 - Luphia) Spacer */}
        </div>

        {/* Info: (20260113 - Luphia) Row 4 */}
        <div className="flex justify-center gap-1">
          <button
            onClick={() => setIsShift(!isShift)}
            className={`px-3 py-2 rounded-lg text-sm font-bold shadow-sm transition-all min-w-[36px] ${isShift ? 'bg-blue-500 text-white' : 'bg-white text-slate-500'}`}
          >
            ⇧
          </button>

          {row4.map(key => (
            <KeyButton key={key} label={isShift ? key.toUpperCase() : key} onClick={() => handleKeyClick(key)} />
          ))}

          <button
            onClick={onDelete}
            className="px-3 py-2 bg-slate-200 rounded-lg text-sm font-bold text-slate-600 shadow-sm active:bg-slate-300 transition-all min-w-[36px]"
          >
            ⌫
          </button>

          {onEnter && (
            <button
              onClick={onEnter}
              className="px-3 py-2 bg-blue-500 rounded-lg text-sm font-bold text-white shadow-sm active:bg-blue-600 transition-all min-w-[48px]"
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
      className="flex-1 bg-white rounded-lg shadow-sm py-2.5 text-sm font-bold text-slate-600 active:bg-blue-50 active:scale-95 transition-all min-w-[28px] max-w-[40px] flex justify-center items-center"
    >
      {label}
    </button>
  );
}
