import React, { useEffect, useRef, useState } from 'react';
import { Download, FileJson, GitMerge, ListPlus, Loader2, MoreHorizontal, RefreshCw, ScanText, UploadCloud, Volume2 } from 'lucide-react';
import type { SyncStatus } from '../../types';
import { SpeechStyleToggle } from '../../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../../components/PlaybackSpeedToggle';

interface NotebookToolsMenuProps {
  /** Offline the menu isn't shown; it stays mounted, so it keeps its state. */
  isOnline: boolean;
  onAnalyzeText: () => void;
  onBatchImport: () => void;
  onImportJSON: () => void;
  onDownloadOfflineImages: () => void;
  onForceSync: () => void;
  syncStatus: SyncStatus;
  onGenerateAllSpeech: () => void;
  speechGenerationRunning: boolean;
  onRestoreImagesToServer: () => void;
  imageRestoreRunning: boolean;
  onFindDuplicates: () => void;
}

/** The ⋯ button at the head of the notebook's toolbar and the tools it opens. A click outside or Escape closes it. */
export const NotebookToolsMenu: React.FC<NotebookToolsMenuProps> = ({
  isOnline, onAnalyzeText, onBatchImport, onImportJSON, onDownloadOfflineImages, onForceSync, syncStatus,
  onGenerateAllSpeech, speechGenerationRunning, onRestoreImagesToServer, imageRestoreRunning, onFindDuplicates,
}) => {
  const [showMaintenanceMenu, setShowMaintenanceMenu] = useState(false);
  const maintenanceMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMaintenanceMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (maintenanceMenuRef.current && !maintenanceMenuRef.current.contains(event.target as Node)) {
        setShowMaintenanceMenu(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); // closing the menu is all this Escape does
      setShowMaintenanceMenu(false);
      maintenanceMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showMaintenanceMenu]);

  if (!isOnline) return null;

  return (
    <div className="relative shrink-0" ref={maintenanceMenuRef}>
      <button
        onClick={() => setShowMaintenanceMenu(open => !open)}
        className="w-11 h-11 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
        aria-label="Notebook tools"
        aria-haspopup="menu"
        aria-expanded={showMaintenanceMenu}
        title="Notebook tools"
      >
        <MoreHorizontal size={20} />
      </button>
      {showMaintenanceMenu && (
        <div role="menu" className="absolute right-0 top-full mt-1 w-64 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50">
          <div className="min-h-11 px-3 py-2 flex items-center justify-between gap-3 border-b border-slate-100">
            <span className="text-sm text-slate-600">Speech playback</span>
            <div className="flex items-center gap-1">
              <SpeechStyleToggle className="shrink-0" />
              <PlaybackSpeedToggle className="shrink-0 bg-slate-100 hover:bg-slate-200" />
            </div>
          </div>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onAnalyzeText(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
            <ScanText size={17} /> Analyze text
          </button>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onBatchImport(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
            <ListPlus size={17} /> Batch import
          </button>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onImportJSON(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
            <FileJson size={17} /> Import JSON
          </button>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onDownloadOfflineImages(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
            <Download size={17} /> Download image pack
          </button>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onForceSync(); }} disabled={syncStatus === 'syncing'} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {syncStatus === 'syncing' ? <Loader2 size={17} className="animate-spin" /> : <RefreshCw size={17} />} Sync now
          </button>
          <div className="h-px bg-slate-100 my-1" />
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onGenerateAllSpeech(); }} disabled={speechGenerationRunning} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {speechGenerationRunning ? <Loader2 size={17} className="animate-spin" /> : <Volume2 size={17} />} Generate speech cache
          </button>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onRestoreImagesToServer(); }} disabled={imageRestoreRunning} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            {imageRestoreRunning ? <Loader2 size={17} className="animate-spin" /> : <UploadCloud size={17} />} Restore server images
          </button>
          <button role="menuitem" onClick={() => { setShowMaintenanceMenu(false); onFindDuplicates(); }} className="w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50">
            <GitMerge size={17} /> Merge duplicates
          </button>
        </div>
      )}
    </div>
  );
};
