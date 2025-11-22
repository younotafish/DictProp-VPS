import React, { useState } from 'react';
import { SyncConfig } from '../types';
import { X, Cloud, Check, AlertCircle, Loader2, HelpCircle } from 'lucide-react';
import { Button } from './Button';

interface Props {
  config: SyncConfig;
  onSave: (config: SyncConfig) => void;
  onClose: () => void;
  onSyncNow: (config: SyncConfig) => Promise<void>;
}

export const SyncModal: React.FC<Props> = ({ config, onSave, onClose, onSyncNow }) => {
  const [url, setUrl] = useState(config.serverUrl || '');
  const [key, setKey] = useState(config.apiKey || '');
  const [enabled, setEnabled] = useState(config.enabled);
  const [status, setStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  const handleSave = () => {
    onSave({
      type: 'custom',
      enabled,
      serverUrl: url,
      apiKey: key,
      lastSynced: config.lastSynced
    });
    onClose();
  };

  const handleTestSync = async () => {
    if (!url) {
        setStatus('error');
        setMsg('Server URL is required');
        return;
    }
    
    setStatus('syncing');
    setMsg('');
    
    try {
        const tempConfig: SyncConfig = { 
          type: 'custom', 
          enabled: true, 
          serverUrl: url, 
          apiKey: key, 
          lastSynced: 0 
        };
        await onSyncNow(tempConfig);
        setStatus('success');
        setMsg('Sync successful! Settings valid.');
        // Auto save on success
        onSave(tempConfig);
    } catch (e: any) {
        setStatus('error');
        setMsg(e.message || 'Connection failed');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Cloud className="text-indigo-600" size={20} />
            Cloud Sync
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
           <p className="text-sm text-slate-500 mb-6">
             Sync your library across devices using a JSON storage API (e.g., JSONBin.io, MyJson, or your own server).
           </p>

           <div className="space-y-4">
             <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-200">
                <span className="font-medium text-slate-700">Enable Sync</span>
                <button 
                   onClick={() => setEnabled(!enabled)}
                   className={`w-12 h-6 rounded-full transition-colors relative ${enabled ? 'bg-indigo-500' : 'bg-slate-300'}`}
                >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${enabled ? 'left-7' : 'left-1'}`} />
                </button>
             </div>

             <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">Server / API Endpoint</label>
                <input 
                  type="text" 
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://api.jsonbin.io/v3/b/..."
                  className="w-full p-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none text-sm font-mono"
                />
             </div>

             <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1">API Key (Optional)</label>
                <input 
                  type="password" 
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  placeholder="Secret Token / Bearer"
                  className="w-full p-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none text-sm font-mono"
                />
             </div>
             
             {status === 'error' && (
                 <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl flex items-center gap-2">
                     <AlertCircle size={16} />
                     {msg}
                 </div>
             )}
             
             {status === 'success' && (
                 <div className="p-3 bg-emerald-50 text-emerald-600 text-sm rounded-xl flex items-center gap-2">
                     <Check size={16} />
                     {msg}
                 </div>
             )}

             <div className="pt-2 flex gap-3">
                 <Button 
                    type="button" 
                    variant="secondary" 
                    className="flex-1"
                    onClick={handleTestSync}
                    disabled={status === 'syncing'}
                 >
                    {status === 'syncing' ? <Loader2 className="animate-spin" size={18}/> : 'Test & Sync'}
                 </Button>
                 <Button 
                    type="button" 
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                    onClick={handleSave}
                 >
                    Save
                 </Button>
             </div>
           </div>

           <div className="mt-6 pt-6 border-t border-slate-100">
               <h4 className="text-xs font-bold text-slate-400 mb-2 flex items-center gap-1">
                   <HelpCircle size={12} /> QUICK SETUP GUIDE
               </h4>
               <ul className="text-xs text-slate-500 space-y-2 list-disc pl-4">
                   <li>Go to <strong>jsonbin.io</strong> (or similar).</li>
                   <li>Create a new bin with empty array <code>[]</code>.</li>
                   <li>Copy the <strong>Bin URL</strong> (e.g., .../v3/b/&lt;ID&gt;) into Endpoint.</li>
                   <li>If private, copy your <strong>Master Key</strong> into API Key.</li>
               </ul>
           </div>
        </div>
      </div>
    </div>
  );
};