
import React, { useState } from 'react';
import { X, Flame, Check, AlertCircle, HelpCircle, Copy, Globe, AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { saveConfig } from '../services/firebase';

interface Props {
  onClose: () => void;
}

export const FirebaseConfigModal: React.FC<Props> = ({ onClose }) => {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const currentDomain = window.location.host || window.location.origin || "Unable to detect URL";

  const handleCopyDomain = () => {
    navigator.clipboard.writeText(currentDomain);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = () => {
    try {
        // Try to clean up input if user pasted 'const firebaseConfig = { ... }'
        let cleanJson = input;
        if (input.includes('=')) {
            cleanJson = input.split('=')[1].trim();
            if (cleanJson.endsWith(';')) cleanJson = cleanJson.slice(0, -1);
        }

        const config = JSON.parse(cleanJson);
        
        if (!config.apiKey || !config.projectId) {
            throw new Error("Invalid Config: Missing apiKey or projectId.");
        }

        saveConfig(config);
    } catch (e: any) {
        setError(e.message || "Invalid JSON format.");
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Flame className="text-orange-500" size={20} />
            Setup Firebase Sync
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
           
           {/* CRITICAL DOMAIN STEP - MOVED TO TOP */}
           <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 mb-6">
               <h4 className="text-xs font-bold text-amber-700 uppercase mb-2 flex items-center gap-1">
                   <AlertTriangle size={14} /> Step 1: Whitelist This Domain
               </h4>
               <p className="text-xs text-amber-800 mb-3">
                   Copy the domain below and add it to <strong>Firebase Console &rarr; Authentication &rarr; Settings &rarr; Authorized Domains</strong>.
                   <br/>
                   <span className="font-bold">Sign-in will fail if you skip this.</span>
               </p>
               <div className="flex items-center gap-2 bg-white p-3 rounded-lg border border-amber-200 shadow-sm">
                   <Globe size={16} className="text-amber-400 shrink-0" />
                   <code className="text-sm font-mono text-slate-700 font-bold break-all flex-1">{currentDomain}</code>
                   <button 
                     onClick={handleCopyDomain}
                     className="p-2 text-amber-600 hover:bg-amber-100 rounded transition-colors shrink-0 font-bold text-xs flex items-center gap-1"
                   >
                       {copied ? <Check size={14} /> : <Copy size={14} />}
                       {copied ? 'Copied' : 'Copy'}
                   </button>
               </div>
           </div>

           <div className="flex items-center gap-2 mb-4">
             <div className="h-px bg-slate-100 flex-1"></div>
             <span className="text-xs font-bold text-slate-300 uppercase">Then</span>
             <div className="h-px bg-slate-100 flex-1"></div>
           </div>

           <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 mb-4">
               <h4 className="text-xs font-bold text-slate-500 uppercase mb-2 flex items-center gap-1">
                   <HelpCircle size={12} /> Step 2: Paste Config
               </h4>
               <ul className="text-xs text-slate-500 list-disc pl-4 space-y-1">
                   <li>Go to Project Settings &rarr; General &rarr; Your apps.</li>
                   <li>Copy the <code>const firebaseConfig = {'{...}'}</code> object.</li>
                   <li>Paste it below.</li>
               </ul>
           </div>

           <textarea 
              value={input}
              onChange={e => { setInput(e.target.value); setError(null); }}
              placeholder={'{ "apiKey": "AIza...", "authDomain": "...", ... }'}
              className="w-full h-32 p-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none text-xs font-mono mb-4 shadow-inner bg-slate-50"
           />
             
           {error && (
                <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl flex items-center gap-2 mb-4">
                    <AlertCircle size={16} />
                    {error}
                </div>
           )}

           <div className="flex gap-3 justify-end">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={handleSave} disabled={!input.trim()}>Save & Restart</Button>
           </div>
        </div>
      </div>
    </div>
  );
};
