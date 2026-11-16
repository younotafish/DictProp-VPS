import React, { useEffect, useId, useRef, useState } from 'react';
import { Download, FileJson, GitMerge, Keyboard, ListPlus, Loader2, MoreHorizontal, RefreshCw, ScanText, UploadCloud, Volume2 } from 'lucide-react';
import type { SyncStatus } from '../../types';
import { NEEDS_CONNECTION, networkRowDisabled, type HeaderControl } from '../../services/connectivityNotice';
import { SpeechStyleToggle } from '../../components/SpeechStyleToggle';
import { PlaybackSpeedToggle } from '../../components/PlaybackSpeedToggle';

interface NotebookToolsMenuProps {
  /** An outage has settled: the tools that need the server are disabled, with the reason. */
  offline: boolean;
  onAnalyzeText: () => void;
  onBatchImport: () => void;
  /** A batch import is running: its tool shows busy until it ends. */
  batchImportRunning: boolean;
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
  /** Why the tool can't run now (offline, NEEDS_CONNECTION): the item is disabled and says so under its label. */
  disabledReason?: string;
}

const MenuItem: React.FC<MenuItemProps> = ({ icon, label, onSelect, busy, disabledReason }) => (
  <button
    onClick={onSelect}
    disabled={busy || disabledReason !== undefined}
    className={`w-full min-h-11 px-3 py-2 flex items-center gap-3 text-sm text-slate-700 hover:bg-slate-50${busy === undefined && disabledReason === undefined ? '' : ' disabled:opacity-50'}`}
  >
    {busy ? <Loader2 size={17} className="animate-spin" /> : icon}
    {disabledReason === undefined ? ` ${label}` : (
      <span className="flex flex-col items-start text-left">
        {label}
        <span className="text-xs text-slate-500">{disabledReason}</span>
      </span>
    )}
  </button>
);

type NotebookToolsPanelProps = NotebookToolsMenuProps & {
  /** Runs before the chosen tool, to close the menu. */
  onChosen: () => void;
};

/**
 * What the open menu lists: the speech settings, then the tools as plain buttons in tab order, then the shortcut sheet.
 * Offline, the tools that need the server stay in place, disabled with the reason (services/connectivityNotice).
 */
export const NotebookToolsPanel: React.FC<NotebookToolsPanelProps> = ({
  offline, onAnalyzeText, onBatchImport, batchImportRunning, onImportJSON, onDownloadOfflineImages, onForceSync,
  syncStatus, onGenerateAllSpeech, speechGenerationRunning, onRestoreImagesToServer, imageRestoreRunning,
  onFindDuplicates, onShowShortcuts, onChosen,
}) => {
  // Choosing a tool closes the menu first.
  const choose = (tool: () => void) => () => {
    onChosen();
    tool();
  };
  const reason = (control: HeaderControl) => (networkRowDisabled(control, !offline) ? NEEDS_CONNECTION : undefined);

  return (
    <>
      <div className="min-h-11 px-3 py-2 flex items-center justify-between gap-3 border-b border-slate-100">
        <span className="text-sm text-slate-600">Speech playback</span>
        <div className="flex items-center gap-1">
          <SpeechStyleToggle className="shrink-0" />
          <PlaybackSpeedToggle className="shrink-0 bg-slate-100 hover:bg-slate-200" />
        </div>
      </div>
      <MenuItem icon={<ScanText size={17} />} label="Analyze text" onSelect={choose(onAnalyzeText)} disabledReason={reason('analyze')} />
      <MenuItem icon={<ListPlus size={17} />} label="Batch import" onSelect={choose(onBatchImport)} busy={batchImportRunning} disabledReason={reason('batch')} />
      <MenuItem icon={<FileJson size={17} />} label="Import JSON" onSelect={choose(onImportJSON)} disabledReason={reason('json')} />
      <MenuItem icon={<Download size={17} />} label="Download image pack" onSelect={choose(onDownloadOfflineImages)} disabledReason={reason('images')} />
      <MenuItem icon={<RefreshCw size={17} />} label="Sync now" onSelect={choose(onForceSync)} busy={syncStatus === 'syncing'} disabledReason={reason('sync')} />
      <div className="h-px bg-slate-100 my-1" />
      <MenuItem icon={<Volume2 size={17} />} label="Generate speech cache" onSelect={choose(onGenerateAllSpeech)} busy={speechGenerationRunning} disabledReason={reason('speech')} />
      <MenuItem icon={<UploadCloud size={17} />} label="Restore server images" onSelect={choose(onRestoreImagesToServer)} busy={imageRestoreRunning} disabledReason={reason('restore')} />
      <MenuItem icon={<GitMerge size={17} />} label="Merge duplicates" onSelect={choose(onFindDuplicates)} disabledReason={reason('merge')} />
      {onShowShortcuts && (
        <>
          <div className="h-px bg-slate-100 my-1" />
          <MenuItem icon={<Keyboard size={17} />} label="Gestures & shortcuts" onSelect={choose(onShowShortcuts)} disabledReason={reason('shortcuts')} />
        </>
      )}
    </>
  );
};

/**
 * The ⋯ button at the head of the notebook's toolbar and the panel of tools it discloses (NotebookToolsPanel), there
 * offline too, so the header keeps its shape. A click outside or Escape closes it.
 */
export const NotebookToolsMenu: React.FC<NotebookToolsMenuProps> = props => {
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
          <NotebookToolsPanel {...props} onChosen={() => setShowMaintenanceMenu(false)} />
        </div>
      )}
    </div>
  );
};
