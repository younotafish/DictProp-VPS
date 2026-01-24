import React from 'react';
import { X, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Button } from './Button';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'success' | 'info';
  onConfirm: () => void;
  onCancel: () => void;
  showCancel?: boolean;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'info',
  onConfirm,
  onCancel,
  showCancel = true
}) => {
  if (!isOpen) return null;

  const variantStyles = {
    danger: {
      bg: 'bg-rose-50',
      border: 'border-rose-100',
      iconBg: 'bg-rose-100',
      iconColor: 'text-rose-500',
      buttonClass: 'bg-rose-500 hover:bg-rose-600 shadow-rose-200',
      Icon: AlertCircle
    },
    warning: {
      bg: 'bg-amber-50',
      border: 'border-amber-100',
      iconBg: 'bg-amber-100',
      iconColor: 'text-amber-500',
      buttonClass: 'bg-amber-500 hover:bg-amber-600 shadow-amber-200',
      Icon: AlertCircle
    },
    success: {
      bg: 'bg-emerald-50',
      border: 'border-emerald-100',
      iconBg: 'bg-emerald-100',
      iconColor: 'text-emerald-500',
      buttonClass: 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-200',
      Icon: CheckCircle2
    },
    info: {
      bg: 'bg-indigo-50',
      border: 'border-indigo-100',
      iconBg: 'bg-indigo-100',
      iconColor: 'text-indigo-500',
      buttonClass: 'bg-indigo-500 hover:bg-indigo-600 shadow-indigo-200',
      Icon: Info
    }
  };

  const style = variantStyles[variant];
  const { Icon } = style;

  return (
    <div 
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] flex items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onCancel}
    >
      <div 
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className={`p-4 ${style.bg} ${style.border} border-b flex justify-between items-center`}>
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <div className={`w-8 h-8 ${style.iconBg} ${style.iconColor} rounded-full flex items-center justify-center`}>
              <Icon size={18} />
            </div>
            {title}
          </h3>
          <button 
            onClick={onCancel} 
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
              variant="primary" 
              onClick={onConfirm} 
              className={`flex-1 border-0 ${style.buttonClass}`}
            >
              {confirmText}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
