import React, { useEffect, useId, useRef, useState } from 'react';
import { Download, FileJson, GitMerge, Keyboard, ListPlus, Loader2, MoreHorizontal, RefreshCw, ScanText, UploadCloud, Volume2 } from 'lucide-react';
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
  /** Opens the gestures and shortcuts sheet: on a phone, the only way to it. */
  onShowShortcuts?: () => void;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
  /** Given for a tool that runs a job: true while it runs, which disables the item and spins its icon. */
  busy?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, onSelect, busy }) => (
  <button
    onClick={onSelect}
    disabled={busy}
    className={`w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50${busy === undefined ? '' : ' disabled:opacity-50'}`}
  >
    {busy ? <Loader2 size={17} className="animate-spin" /> : icon}{` ${label}`}
  </button>
);

type NotebookToolsPanelProps = Omit<NotebookToolsMenuProps, 'isOnline'> & {
  /** Runs before the chosen tool, to close the menu. */
  onChosen: () => void;
};

/** What the open menu lists: the speech settings, then the tools as plain buttons in tab order, then the shortcut sheet. */
export const NotebookToolsPanel: React.FC<NotebookToolsPanelProps> = ({
  onAnalyzeText, onBatchImport, onImportJSON, onDownloadOfflineImages, onForceSync, syncStatus, onGenerateAllSpeech,
  speechGenerationRunning, onRestoreImagesToServer, imageRestoreRunning, onFindDuplicates, onShowShortcuts, onChosen,
}) => {
  // Choosing a tool closes the menu first.
  const choose = (tool: () => void) => () => {
    onChosen();
    tool();
  };

  return (
    <>
      <div className="min-h-11 px-3 py-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <span className="text-sm text-slate-600">Speech playback</span>
        <div className="flex items-center gap-1">
          <SpeechStyleToggle className="shrink-0" />
          <PlaybackSpeedToggle className="shrink-0 bg-slate-100 hover:bg-slate-200" />
        </div>
      </div>
      <MenuItem icon={<ScanText size={17} />} label="Analyze text" onSelect={choose(onAnalyzeText)} />
      <MenuItem icon={<ListPlus size={17} />} label="Batch import" onSelect={choose(onBatchImport)} />
      <MenuItem icon={<FileJson size={17} />} label="Import JSON" onSelect={choose(onImportJSON)} />
      <MenuItem icon={<Download size={17} />} label="Download image pack" onSelect={choose(onDownloadOfflineImages)} />
      <MenuItem icon={<RefreshCw size={17} />} label="Sync now" onSelect={choose(onForceSync)} busy={syncStatus === 'syncing'} />
      <div className="h-px bg-slate-100 my-1" />
      <MenuItem icon={<Volume2 size={17} />} label="Generate speech cache" onSelect={choose(onGenerateAllSpeech)} busy={speechGenerationRunning} />
      <MenuItem icon={<UploadCloud size={17} />} label="Restore server images" onSelect={choose(onRestoreImagesToServer)} busy={imageRestoreRunning} />
      <MenuItem icon={<GitMerge size={17} />} label="Merge duplicates" onSelect={choose(onFindDuplicates)} />
      {onShowShortcuts && (
        <>
          <div className="h-px bg-slate-100 my-1" />
          <MenuItem icon={<Keyboard size={17} />} label="Gestures & shortcuts" onSelect={choose(onShowShortcuts)} />
        </>
      )}
    </>
  );
};

/**
 * The ⋯ button at the head of the notebook's toolbar and the panel of tools it discloses (NotebookToolsPanel). A
 * click outside or Escape closes it.
 */
export const NotebookToolsMenu: React.FC<NotebookToolsMenuProps> = ({ isOnline, ...tools }) => {
  const [showMaintenanceMenu, setShowMaintenanceMenu] = useState(false);
  const maintenanceMenuRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

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
        aria-expanded={showMaintenanceMenu}
        aria-controls={showMaintenanceMenu ? panelId : undefined}
        title="Notebook tools"
      >
        <MoreHorizontal size={20} />
      </button>
      {showMaintenanceMenu && (
        <div id={panelId} className="absolute right-0 top-full mt-1 w-64 max-h-[70vh] overflow-y-auto bg-white rounded-lg shadow-lg border border-slate-200 py-1 z-50">
          <NotebookToolsPanel {...tools} onChosen={() => setShowMaintenanceMenu(false)} />
        </div>
      )}
    </div>
  );
};
