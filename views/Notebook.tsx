
import React, { useRef } from 'react';
import { StoredItem, SyncConfig, SyncStatus } from '../types';
import { Trash2, Search, BookOpen, Layers, Download, Upload, Cloud, AlertCircle, Check, Loader2 } from 'lucide-react';
import { exportBackup, validateBackup } from '../services/storage';
import { Button } from '../components/Button';
import { UserMenu } from '../components/UserMenu';

interface NotebookProps {
  items: StoredItem[];
  onDelete: (id: string) => void;
  onSearch: (text: string) => void;
  onViewDetail: (item: StoredItem) => void;
  onImport: (items: StoredItem[]) => void;
  user: any | null;
  onSignIn: () => void;
  onGuestSignIn?: () => void;
  onSignOut: () => void;
  onSetup: () => void; // Legacy prop name, but we'll pass open settings
  isConfigured: boolean;
  syncStatus?: SyncStatus;
}

export const NotebookView: React.FC<NotebookProps> = ({ 
    items, onDelete, onSearch, onViewDetail, onImport, 
    user, onSignIn, onGuestSignIn, onSignOut, onSetup, isConfigured, syncStatus 
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Filter out deleted items for display
  const displayItems = items.filter(i => !i.isDeleted);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
          const importedItems = await validateBackup(file);
          onImport(importedItems);
      } catch (err) {
          alert("Failed to import backup.");
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerImport = () => {
      fileInputRef.current?.click();
  };

  const getSyncIcon = () => {
      if (syncStatus === 'syncing') return <Loader2 className="animate-spin text-blue-500" size={20} />;
      if (syncStatus === 'saved') return <Check className="text-emerald-500" size={20} />;
      if (syncStatus === 'error') return <AlertCircle className="text-red-500" size={20} />;
      return <Cloud className="text-slate-400" size={20} />;
  };

  // Retrieve current config from localstorage for the UserMenu
  const syncConfig = React.useMemo(() => {
      const saved = localStorage.getItem('popdict_sync_config');
      return saved ? JSON.parse(saved) : { type: 'firebase', enabled: true };
  }, []);

  if (displayItems.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center">
        <BookOpen size={48} className="mb-4 opacity-20" />
        <h3 className="text-lg font-semibold text-slate-600">Your notebook is empty</h3>
        <p className="text-sm mb-6">Save words to build your library. Sign in to sync.</p>
        <div className="flex gap-3 mb-6">
            <Button variant="secondary" size="sm" onClick={triggerImport} className="flex items-center gap-2">
                <Upload size={16} /> Restore Backup
            </Button>
        </div>
        <UserMenu 
            user={user} 
            syncConfig={syncConfig}
            onSignIn={onSignIn} 
            onGuestSignIn={onGuestSignIn}
            onSignOut={onSignOut} 
            onOpenSettings={onSetup} 
            isConfigured={isConfigured} 
        />
        <input type="file" hidden ref={fileInputRef} onChange={handleFileChange} accept=".json" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-4 pb-24 bg-slate-50">
      <div className="flex justify-between items-center mb-6 px-2">
        <h2 className="text-2xl font-bold text-slate-800">Notebook</h2>
        <div className="flex items-center gap-2">
             <div className="mr-2" title={`Sync Status: ${syncStatus}`}>
                 {getSyncIcon()}
             </div>
             <UserMenu 
                user={user} 
                syncConfig={syncConfig}
                onSignIn={onSignIn} 
                onGuestSignIn={onGuestSignIn}
                onSignOut={onSignOut} 
                onOpenSettings={onSetup} 
                isConfigured={isConfigured} 
             />
            <Button variant="ghost" size="sm" onClick={() => exportBackup(displayItems)} title="Export Backup">
                <Download size={20} className="text-slate-500" />
            </Button>
            <Button variant="ghost" size="sm" onClick={triggerImport} title="Import Backup">
                <Upload size={20} className="text-slate-500" />
            </Button>
        </div>
      </div>
      
      <input type="file" hidden ref={fileInputRef} onChange={handleFileChange} accept=".json" />

      <div className="grid gap-3">
        {displayItems.map((item) => {
          const isPhrase = item.type === 'phrase';
          const title = isPhrase 
            ? (item.data as any).query 
            : (item.data as any).word;
          const subtitle = isPhrase 
            ? (item.data as any).translation 
            : (item.data as any).chinese;

          return (
            <div 
              key={item.data.id} 
              onClick={() => onViewDetail(item)}
              className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 grid grid-cols-[auto_1fr_auto] gap-4 items-center active:scale-[0.99] transition-transform cursor-pointer"
            >
               <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isPhrase ? 'bg-indigo-100 text-indigo-600' : 'bg-emerald-100 text-emerald-600'}`}>
                  {isPhrase ? <Layers size={18}/> : <span className="font-serif font-bold italic">Aa</span>}
               </div>
               
               <div className="min-w-0">
                 <h4 className="font-bold text-slate-800 truncate">{title}</h4>
                 <p className="text-sm text-slate-500 truncate">{subtitle}</p>
               </div>
              
               <div className="flex items-center gap-1">
                 <button 
                    onClick={(e) => { e.stopPropagation(); onSearch(title); }}
                    className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                 >
                    <Search size={18} />
                 </button>
                 <button 
                    onClick={(e) => { e.stopPropagation(); onDelete(item.data.id); }}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                 >
                    <Trash2 size={18} />
                 </button>
               </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
