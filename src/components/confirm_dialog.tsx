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
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onCancel}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
        aria-label="Close dialog"
      />

      {/* Info: (20260113 - Luphia) Modal */}
      <div className={`
        bg-white rounded-2xl w-full max-w-sm p-6 shadow-2xl z-10 
        transform transition-all duration-300
        ${isOpen ? 'scale-100 translate-y-0' : 'scale-95 translate-y-4'}
      `}>
        <h3 className={`text-lg font-bold mb-2 ${type === 'danger' ? 'text-red-600' : 'text-slate-800'}`}>
          {title}
        </h3>
        <p className="text-slate-500 mb-6 text-sm leading-relaxed">
          {description}
        </p>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-50 transition-colors text-sm"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className={`
              flex-1 px-4 py-2.5 rounded-xl text-white font-bold transition-colors shadow-lg text-sm
              ${type === 'danger'
                ? 'bg-red-500 hover:bg-red-600 shadow-red-500/30'
                : 'bg-blue-500 hover:bg-blue-600 shadow-blue-500/30'}
            `}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
