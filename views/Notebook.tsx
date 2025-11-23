
import React, { useRef } from 'react';
import { StoredItem, SyncConfig, SyncStatus } from '../types';
import { Trash2, Search, BookOpen, Layers, Download, Upload, Cloud, AlertCircle, Check, Loader2, MoreVertical } from 'lucide-react';
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
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

export const NotebookView: React.FC<NotebookProps> = ({ 
    items, onDelete, onSearch, onViewDetail, onImport, 
    user, onSignIn, onGuestSignIn, onSignOut, onSetup, isConfigured, syncStatus, onScroll 
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
      if (syncStatus === 'syncing') return <Loader2 className="animate-spin text-indigo-500" size={16} />;
      if (syncStatus === 'saved') return <Check className="text-emerald-500" size={16} />;
      if (syncStatus === 'error') return <AlertCircle className="text-red-500" size={16} />;
      return <Cloud className="text-slate-400" size={16} />;
  };

  // Retrieve current config from localstorage for the UserMenu
  const syncConfig = React.useMemo(() => {
      const saved = localStorage.getItem('popdict_sync_config');
      return saved ? JSON.parse(saved) : { type: 'firebase', enabled: true };
  }, []);

  if (displayItems.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center bg-slate-50">
        <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
            <BookOpen size={32} className="text-indigo-300" />
        </div>
        <h3 className="text-xl font-bold text-slate-700 mb-2">Your notebook is empty</h3>
        <p className="text-sm mb-8 max-w-xs mx-auto">Save words from your searches to build your personal library.</p>
        
        <div className="flex flex-col gap-3 w-full max-w-xs">
            <Button variant="secondary" size="sm" onClick={triggerImport} className="flex items-center justify-center gap-2 w-full">
                <Upload size={16} /> Restore Backup
            </Button>
            <div className="flex justify-center pt-4">
                <UserMenu 
                    user={user} 
                    syncConfig={syncConfig}
                    onSignIn={onSignIn} 
                    onGuestSignIn={onGuestSignIn}
                    onSignOut={onSignOut} 
                    onOpenSettings={onSetup} 
                    isConfigured={isConfigured} 
                />
            </div>
        </div>
        <input type="file" hidden ref={fileInputRef} onChange={handleFileChange} accept=".json" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-slate-50" onScroll={onScroll}>
      {/* Header */}
      <div className="sticky top-0 z-10 bg-slate-50/90 backdrop-blur-md px-6 py-4 border-b border-slate-200/50 flex justify-between items-center">
        <div>
            <h2 className="text-2xl font-bold text-slate-900">Notebook</h2>
            <p className="text-xs text-slate-500 font-medium">{displayItems.length} items stored</p>
        </div>
        <div className="flex items-center gap-1 bg-white rounded-full p-1 pl-3 border border-slate-100 shadow-sm">
             <div className="mr-2 flex items-center gap-2" title={`Sync Status: ${syncStatus}`}>
                 <span className="text-[10px] font-bold uppercase text-slate-400 tracking-wider hidden sm:inline">Sync</span>
                 {getSyncIcon()}
             </div>
             <div className="h-4 w-[1px] bg-slate-200 mx-1"></div>
             <UserMenu 
                user={user} 
                syncConfig={syncConfig}
                onSignIn={onSignIn} 
                onGuestSignIn={onGuestSignIn}
                onSignOut={onSignOut} 
                onOpenSettings={onSetup} 
                isConfigured={isConfigured} 
             />
             <Button variant="icon" size="sm" onClick={() => exportBackup(displayItems)} title="Export Backup">
                <Download size={18} className="text-slate-400 hover:text-slate-600" />
             </Button>
             <Button variant="icon" size="sm" onClick={triggerImport} title="Import Backup">
                <Upload size={18} className="text-slate-400 hover:text-slate-600" />
             </Button>
        </div>
      </div>
      
      <input type="file" hidden ref={fileInputRef} onChange={handleFileChange} accept=".json" />

      <div className="p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] grid gap-3 max-w-3xl mx-auto">
        {displayItems.map((item) => {
          const isPhrase = item.type === 'phrase';
          const title = isPhrase 
            ? (item.data as any).query 
            : (item.data as any).word;
          const subtitle = isPhrase 
            ? (item.data as any).translation 
            : (item.data as any).chinese;
          
          // Calculate SRS status color
          const nextReview = item.srs.nextReview;
          const isDue = nextReview <= Date.now();
          const intervalDays = Math.round(item.srs.interval / (24 * 60));

          return (
            <div 
              key={item.data.id} 
              onClick={() => onViewDetail(item)}
              className="group bg-white p-4 rounded-2xl shadow-sm border border-slate-100 hover:shadow-md hover:border-indigo-100 transition-all duration-200 cursor-pointer relative overflow-hidden"
            >
               {/* SRS Indicator Strip */}
               <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${isDue ? 'bg-orange-400' : (intervalDays > 21 ? 'bg-emerald-400' : 'bg-slate-200')}`}></div>

               <div className="flex items-start gap-4 pl-2">
                   <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${isPhrase ? 'bg-indigo-50 text-indigo-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      {isPhrase ? <Layers size={20} strokeWidth={2.5} /> : <span className="font-serif font-bold italic text-xl">Aa</span>}
                   </div>
                   
                   <div className="min-w-0 flex-1 pt-0.5">
                     <div className="flex justify-between items-start">
                        <h4 className="font-bold text-slate-900 text-lg truncate leading-tight">{title}</h4>
                        {isDue && <span className="text-[10px] font-bold text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0 ml-2">Due</span>}
                     </div>
                     <p className="text-sm text-slate-500 truncate mt-1">{subtitle}</p>
                   </div>

                   <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity sm:opacity-100">
                     <button 
                        onClick={(e) => { e.stopPropagation(); onSearch(title); }}
                        className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="Search again"
                     >
                        <Search size={18} />
                     </button>
                     <button 
                        onClick={(e) => { e.stopPropagation(); onDelete(item.data.id); }}
                        className="p-2 text-slate-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                     >
                        <Trash2 size={18} />
                     </button>
                   </div>
               </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
