import React, { useEffect } from 'react';
import { X, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'success' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
  showCancel?: boolean;
}

// The header's tones. The confirm button is rose for a danger and indigo otherwise, as it has always rendered.
const variantStyles = {
  danger: {
    bg: 'bg-rose-50',
    border: 'border-rose-100',
    iconBg: 'bg-rose-100',
    iconColor: 'text-rose-500',
    Icon: AlertCircle
  },
  warning: {
    bg: 'bg-amber-50',
    border: 'border-amber-100',
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-500',
    Icon: AlertCircle
  },
  success: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-100',
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-500',
    Icon: CheckCircle2
  },
  info: {
    bg: 'bg-indigo-50',
    border: 'border-indigo-100',
    iconBg: 'bg-indigo-100',
    iconColor: 'text-indigo-500',
    Icon: Info
  }
};

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
  onConfirm,
  onCancel,
  showCancel = true
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat || e.isComposing) return;
      // Enter on a focused control is that control's own press: on Cancel or the X it must not confirm.
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('button, a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      e.preventDefault();
      onConfirm();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onConfirm]);

  const style = variantStyles[variant];
  const { Icon } = style;

  return (
    <Modal onClose={onCancel} maxWidth="max-w-sm" ariaLabel={title}>
        <div className={`p-4 ${style.bg} ${style.border} border-b flex justify-between items-center`}>
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <div className={`w-8 h-8 ${style.iconBg} ${style.iconColor} rounded-full flex items-center justify-center`}>
              <Icon size={18} />
            </div>
            {title}
          </h3>
          <button 
            onClick={onCancel} 
            aria-label="Close confirmation"
            className="text-slate-400 hover:text-slate-600 p-1 rounded-full hover:bg-white/50 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6">
          <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line mb-6">
            {message}
          </p>

          <div className="flex gap-3">
            {showCancel && (
              <Button variant="secondary" onClick={onCancel} className="flex-1">
                {cancelText}
              </Button>
            )}
            <Button
              variant="plain"
              onClick={onConfirm}
              className={`flex-1 border-0 text-white shadow-lg ${variant === 'danger'
                ? 'bg-rose-500 hover:bg-rose-600 shadow-rose-200'
                : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200'}`}
            >
              {confirmText}
            </Button>
          </div>
        </div>
    </Modal>
  );
};
