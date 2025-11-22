
import React, { useState } from 'react';
import { SyncConfig } from '../types';
import { X, Cloud, Server, Flame, Save, Globe, Key } from 'lucide-react';
import { Button } from './Button';
import { FirebaseConfigModal } from './FirebaseConfigModal'; // Re-use for specific firebase fields if needed, or inline logic

interface Props {
  config: SyncConfig;
  onSave: (config: SyncConfig) => void;
  onClose: () => void;
}

export const SyncSettingsModal: React.FC<Props> = ({ config, onSave, onClose }) => {
  const [type, setType] = useState<'firebase' | 'custom'>(config.type);
  const [url, setUrl] = useState(config.serverUrl || '');
  const [key, setKey] = useState(config.apiKey || '');
  const [showFirebaseDetails, setShowFirebaseDetails] = useState(false);

  const handleSave = () => {
    onSave({
        type,
        enabled: true,
        serverUrl: url,
        apiKey: key,
        lastSynced: Date.now()
    });
    onClose();
  };

  if (showFirebaseDetails) {
      return <FirebaseConfigModal onClose={() => setShowFirebaseDetails(false)} />;
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Cloud className="text-indigo-600" size={20} />
            Sync Settings
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
           
           <div className="grid grid-cols-2 gap-3 mb-6">
               <button 
                 onClick={() => setType('firebase')}
                 className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-all ${type === 'firebase' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-slate-100 bg-white text-slate-400 hover:border-slate-200'}`}
               >
                   <Flame size={24} />
                   <span className="font-bold text-sm">Firebase</span>
               </button>
               <button 
                 onClick={() => setType('custom')}
                 className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-all ${type === 'custom' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-100 bg-white text-slate-400 hover:border-slate-200'}`}
               >
                   <Server size={24} />
                   <span className="font-bold text-sm">Custom Server</span>
               </button>
           </div>

           {type === 'firebase' && (
               <div className="text-center space-y-4">
                   <p className="text-sm text-slate-500">
                       Use Google's Firebase infrastructure. Requires configuration of API Keys and Authorized Domains.
                   </p>
                   <Button onClick={() => setShowFirebaseDetails(true)} variant="secondary" className="w-full">
                       Configure Firebase Keys
                   </Button>
               </div>
           )}

           {type === 'custom' && (
               <div className="space-y-4">
                   <p className="text-xs text-slate-500 mb-4 bg-indigo-50 p-3 rounded-lg border border-indigo-100">
                       <strong>Developer Mode:</strong> Point to your own REST API. <br/>
                       The app will <code>GET</code> and <code>POST</code> a JSON array to this URL.
                   </p>

                   <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1 flex items-center gap-1">
                            <Globe size={12} /> Endpoint URL
                        </label>
                        <input 
                        type="text" 
                        value={url}
                        onChange={e => setUrl(e.target.value)}
                        placeholder="https://api.myserver.com/sync"
                        className="w-full p-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none text-sm font-mono"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1 ml-1 flex items-center gap-1">
                            <Key size={12} /> API Key / Token (Optional)
                        </label>
                        <input 
                        type="password" 
                        value={key}
                        onChange={e => setKey(e.target.value)}
                        placeholder="Bearer Token"
                        className="w-full p-3 rounded-xl border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none text-sm font-mono"
                        />
                    </div>
               </div>
           )}

           <div className="mt-6 pt-6 border-t border-slate-100 flex justify-end">
               <Button onClick={handleSave} className="flex items-center gap-2">
                   <Save size={18} /> Save Settings
               </Button>
           </div>

        </div>
      </div>
    </div>
  );
};
