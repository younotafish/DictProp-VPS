import React from 'react';
import { Loader2 } from 'lucide-react';

/** A batch import running in the background (hooks/useBatchImport). */
export interface BatchImportProgress {
  current: number;
  total: number;
  skipped: number;
  failed: number;
  saved: number;
  isRunning: boolean;
}

/** The progress of a running batch import, at the foot of the notebook's sticky header. */
export const BatchImportBanner: React.FC<{ progress: BatchImportProgress }> = ({ progress }) => (
  <div className="bg-indigo-500 text-white px-4 py-3 shadow-md">
    <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <Loader2 className="animate-spin" size={18} />
        <div>
          <p className="font-medium text-sm">Importing words...</p>
          <p className="text-xs text-indigo-200">
            {progress.current}/{progress.total} done
            {progress.saved > 0 && ` · ${progress.saved} saved`}
            {progress.skipped > 0 && ` · ${progress.skipped} skipped`}
          </p>
        </div>
      </div>
      <div className="w-24 h-2 bg-indigo-400 rounded-full overflow-hidden">
        <div
          className="h-full bg-white transition-all duration-300"
          style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
        />
      </div>
    </div>
  </div>
);
