
import React, { useState } from 'react';
import { X, AlertOctagon, Copy, Check } from 'lucide-react';
import { Button } from './Button';

interface Props {
  error: { code?: string; message: string } | null;
  onClose: () => void;
}

export const ErrorModal: React.FC<Props> = ({ error, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!error) return null;

  const handleCopy = () => {
    const text = `Error Code: ${error.code || 'N/A'}\nMessage: ${error.message}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
        
        <div className="p-4 bg-red-50 border-b border-red-100 flex justify-between items-center">
          <h3 className="font-bold text-red-700 flex items-center gap-2">
            <AlertOctagon className="text-red-600" size={20} />
            Sign In Failed
          </h3>
          <button onClick={onClose} className="text-red-400 hover:text-red-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6">
           {error.code && (
             <div className="mb-2">
               <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Error Code</span>
               <p className="font-mono text-sm text-slate-700 bg-slate-100 p-2 rounded border border-slate-200 mt-1 break-all">
                 {error.code}
               </p>
             </div>
           )}

           <div className="mb-6">
             <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Message</span>
             <p className="text-sm text-slate-600 mt-1 leading-relaxed">
               {error.message}
             </p>
           </div>

           <div className="flex gap-3">
             <Button variant="secondary" onClick={handleCopy} className="flex-1 flex items-center justify-center gap-2">
               {copied ? <Check size={16} className="text-green-600"/> : <Copy size={16} />}
               {copied ? 'Copied' : 'Copy'}
             </Button>
             <Button onClick={onClose} className="flex-1">
               Close
             </Button>
           </div>
        </div>
      </div>
    </div>
  );
};
