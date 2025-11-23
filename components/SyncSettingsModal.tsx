
import React, { useState } from 'react';
import { SyncConfig } from '../types';
import { X, Cloud, Flame } from 'lucide-react';
import { Button } from './Button';
import { FirebaseConfigModal } from './FirebaseConfigModal';

interface Props {
  config: SyncConfig;
  onSave: (config: SyncConfig) => void;
  onClose: () => void;
}

export const SyncSettingsModal: React.FC<Props> = ({ config, onSave, onClose }) => {
  const [showFirebaseDetails, setShowFirebaseDetails] = useState(false);

  if (showFirebaseDetails) {
      return <FirebaseConfigModal onClose={() => setShowFirebaseDetails(false)} />;
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <Cloud className="text-indigo-600" size={20} />
            Firebase Sync Settings
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
           
           <div className="flex justify-center mb-6">
               <div className="p-6 rounded-xl border-2 border-orange-500 bg-orange-50 text-orange-700 flex flex-col items-center gap-3">
                   <Flame size={48} />
                   <span className="font-bold text-lg">Firebase Sync</span>
               </div>
           </div>

           <div className="text-center space-y-4">
               <p className="text-sm text-slate-500">
                   Your app uses Google's Firebase infrastructure for syncing. Configure your Firebase API Keys and Authorized Domains to enable sync.
               </p>
               <Button onClick={() => setShowFirebaseDetails(true)} variant="secondary" className="w-full">
                   Configure Firebase Keys
               </Button>
           </div>

        </div>
      </div>
    </div>
  );
};
