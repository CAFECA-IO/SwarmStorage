interface IConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'danger' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  type = 'danger',
  onConfirm,
  onCancel
}: IConfirmDialogProps) {
  // Info: (20260113 - Luphia) Simple fade using CSS classes only. 
  // Info: (20260113 - Luphia) For proper mount/unmount animations, an animation library or precise timeout is needed. 
  // Info: (20260113 - Luphia) To avoid lint issues with useEffect/setState sync, we use conditional visibility.
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-300 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      {/* Info: (20260113 - Luphia) Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
        aria-label="Close dialog"
      />

      {/* Info: (20260113 - Luphia) Modal */}
      <div className={`
        bg-black/80 backdrop-blur-xl border border-white/10 rounded-3xl w-full max-w-sm p-6 shadow-2xl shadow-emerald-500/5 z-10 
        transform transition-all duration-300 relative overflow-hidden
        ${isOpen ? 'scale-100 translate-y-0' : 'scale-95 translate-y-4'}
      `}>
        {/* Info: (20260113 - Luphia) Decorative Glow */}
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-emerald-500 to-purple-500 opacity-50"></div>

        <h3 className={`text-lg font-bold font-mono mb-2 ${type === 'danger' ? 'text-red-400' : 'text-slate-100'}`}>
          {title}
        </h3>
        <p className="text-slate-400 mb-8 text-sm leading-relaxed font-sans">
          {description}
        </p>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-slate-300 font-bold font-mono hover:bg-white/5 transition-colors text-xs uppercase tracking-wider"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`
              flex-1 px-4 py-2.5 rounded-xl font-bold transition-all shadow-lg text-xs uppercase tracking-wider font-mono border
              ${type === 'danger'
                ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/30 shadow-red-500/10 hover:shadow-red-500/20'
                : 'bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border-cyan-500/30 shadow-cyan-500/10 hover:shadow-cyan-500/20'}
            `}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
