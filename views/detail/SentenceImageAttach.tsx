import { useRef } from 'react';
import { ClipboardPaste, Image as ImageIcon, ImagePlus, Loader2, X } from 'lucide-react';
import { extractImageFromTransfer } from './detailUtils';

/**
 * Attach-image button (sentence review only). Sits above the global AI-search button in the right rail (bottom-40
 * clears its bottom-24; z-[57] is above the search button's z-[55], below the auto-play cluster's z-[60]). A tap
 * opens the panel; a double tap pastes straight from the clipboard.
 */
export function SentenceImageFab({ hasImage, onTap }: { hasImage: boolean; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      className="fixed bottom-40 right-4 z-[57] w-12 h-12 touch-manipulation rounded-full flex items-center justify-center shadow-lg bg-white text-slate-500 border border-slate-200 hover:text-indigo-600 hover:bg-slate-50 transition-all"
      aria-label={hasImage ? 'Replace image; double-tap to paste' : 'Attach image; double-tap to paste'}
      title={hasImage ? 'Replace image; double-tap to paste' : 'Attach image; double-tap to paste'}
    >
      {hasImage ? <ImageIcon size={20} /> : <ImagePlus size={20} />}
    </button>
  );
}

interface SentenceImagePanelProps {
  hasImage: boolean;
  uploading: boolean;
  /** A file is being dragged over the panel. */
  dragOver: boolean;
  onDragOverChange: (over: boolean) => void;
  error: string | null;
  onError: (message: string) => void;
  onClose: () => void;
  /** Attaches the image to the sentence under review; anything that isn't an image is refused there. */
  attach: (file: Blob | null) => Promise<void>;
}

/**
 * Paste, drop or pick an image for the sentence — mirrors the bottom-right AI-search input overlay. The card is
 * focusable and marked data-image-panel so an in-panel ⌘V lands on its onPaste (the window listener is the
 * primary path).
 */
export function SentenceImagePanel({ hasImage, uploading, dragOver, onDragOverChange, error, onError, onClose, attach }: SentenceImagePanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="fixed bottom-28 right-4 left-4 z-[58]">
      <div
        data-image-panel
        tabIndex={-1}
        onPaste={(e) => {
          const f = extractImageFromTransfer(e.clipboardData);
          if (f) { e.preventDefault(); void attach(f); }
        }}
        onDragOver={(e) => { e.preventDefault(); onDragOverChange(true); }}
        onDragLeave={() => onDragOverChange(false)}
        onDrop={(e) => {
          e.preventDefault();
          onDragOverChange(false);
          void attach(extractImageFromTransfer(e.dataTransfer));
        }}
        className={`bg-white rounded-2xl shadow-2xl border p-4 max-w-md ml-auto outline-none transition-colors ${dragOver ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-slate-200'}`}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-slate-700">
            {hasImage ? 'Replace image' : 'Attach image'}
          </span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600" title="Close">
            <X size={18} />
          </button>
        </div>

        {uploading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-slate-500 text-sm">
            <Loader2 size={16} className="animate-spin text-indigo-500" /> Uploading…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="min-h-20 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center gap-1 text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
              >
                <ImagePlus size={22} />
                <span className="text-xs font-medium">Choose photo</span>
              </button>
              <div className="relative min-h-20 overflow-hidden border-2 border-dashed border-slate-200 rounded-xl text-slate-500 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-colors">
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1">
                  <ClipboardPaste size={22} />
                  <span className="text-xs font-medium">Paste image</span>
                  <span className="text-[11px] text-slate-400">Long press</span>
                </div>
                <div
                  contentEditable
                  suppressContentEditableWarning
                  role="textbox"
                  aria-label="Paste an image"
                  inputMode="none"
                  onPaste={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.replaceChildren();
                    const file = extractImageFromTransfer(e.clipboardData);
                    if (file) void attach(file);
                    else onError('The clipboard does not contain an image.');
                  }}
                  onInput={(e) => e.currentTarget.replaceChildren()}
                  className="relative z-10 min-h-20 w-full cursor-text select-text text-transparent caret-transparent outline-none"
                />
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; void attach(f); }}
            />
          </>
        )}
        {error && <p className="mt-2 text-xs text-rose-500">{error}</p>}
      </div>
    </div>
  );
}
