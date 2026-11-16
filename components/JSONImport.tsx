import React, { useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import { ClipboardPaste, Trash2, FileJson, Upload, AlertCircle, CheckCircle2 } from 'lucide-react';
import { importJSON } from '../services/api/jsonImport';
import { importErrorMessage, parseImportText } from '../services/notebook/jsonImport';
import { modifierKeyLabel } from '../services/platform';
import { Sheet } from './Sheet';

interface JSONImportProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void; // called after successful import to trigger sync
}

export const JSONImport: React.FC<JSONImportProps> = ({
  isOpen,
  onClose,
  onImported,
}) => {
  const [inputText, setInputText] = useState('');
  const [status, setStatus] = useState<'idle' | 'importing' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<string>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // An import is on its way to the server. The sheet stays mounted while closed, so this outlives a close.
  const inFlightRef = useRef(false);

  // On opening: focus the box, and start from a clean status, unless an import from before is still running.
  useEffect(() => {
    if (!isOpen) return;
    if (textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
    if (!inFlightRef.current) {
      setStatus('idle');
      setResult('');
    }
  }, [isOpen]);

  // Parsed once per change to the text, in a deferred render, instead of on every render and keystroke:
  // pasted JSON can run to megabytes.
  const deferredText = useDeferredValue(inputText);
  const itemCount = useMemo(
    () => (deferredText.trim() ? parseImportText(deferredText).items?.length || 0 : 0),
    [deferredText],
  );

  // One import at a time. The server gives every card without an id a new one, so sending the same cards twice
  // saves them twice.
  const handleSubmit = useCallback(async () => {
    if (inFlightRef.current) return;
    const { items, error } = parseImportText(inputText);
    if (!items || error) {
      setStatus('error');
      setResult(error || 'Invalid input');
      return;
    }

    inFlightRef.current = true;
    setStatus('importing');
    setResult('');

    try {
      const res = await importJSON(items);
      setStatus('done');
      const parts = [`${res.imported} cards imported`];
      if (res.imagesFetched > 0) parts.push(`${res.imagesFetched} images fetched`);
      if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
      setResult(parts.join(' · '));
      // The cards are in the notebook now; emptying the box, as batch import does, leaves nothing to send again.
      setInputText('');
      onImported();
    } catch (e) {
      setStatus('error');
      setResult(importErrorMessage(e));
    } finally {
      inFlightRef.current = false;
    }
  }, [inputText, onImported]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInputText(text);
    } catch { /* ignore */ }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      // A held shortcut repeats; only the first press imports.
      if (!e.repeat) handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Import JSON" icon={<FileJson size={20} className="text-emerald-600" />}>
      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8">
        {/* Locked while an import runs, Clear and Paste with it: a second import can't start, and the box empties
            when this one lands, so anything put in it meanwhile would be lost. */}
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={inputText}
            readOnly={status === 'importing'}
            onChange={(e) => { setInputText(e.target.value); setStatus('idle'); }}
            onKeyDown={handleKeyDown}
            placeholder={`Paste JSON from your AI tool. Accepts either:

1. Simple format (just vocab cards):
[
  {
    "word": "ubiquitous",
    "chinese": "无处不在的",
    "ipa": "/juːˈbɪkwɪtəs/",
    "definition": "Present everywhere.",
    "synonyms": ["omnipresent"],
    "antonyms": ["rare"],
    "confusables": ["ambiguous"],
    "examples": ["Smartphones are ubiquitous."],
    "history": "From Latin 'ubique'...",
    "register": "Formal/academic",
    "mnemonic": "U-BIG-quit-us...",
    "imageUrl": "https://..."
  }
]

2. Full StoredItem format (advanced)`}
            className="w-full min-h-[200px] max-h-[400px] p-4 pr-12 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all resize-y leading-relaxed font-mono"
          />
          <div className="absolute top-2 right-2 flex flex-col gap-1">
            {!inputText && (
              <button onClick={handlePaste} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors" title="Paste">
                <ClipboardPaste size={16} />
              </button>
            )}
            {inputText && status !== 'importing' && (
              <button onClick={() => { setInputText(''); setStatus('idle'); }} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors" title="Clear">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Status message */}
        {status === 'error' && (
          <div className="mt-3 px-4 py-3 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2">
            <AlertCircle size={16} className="text-rose-500 mt-0.5 shrink-0" />
            <p className="text-sm text-rose-700">{result}</p>
          </div>
        )}
        {status === 'done' && (
          <div className="mt-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2">
            <CheckCircle2 size={16} className="text-emerald-500 mt-0.5 shrink-0" />
            <p className="text-sm text-emerald-700">{result}</p>
          </div>
        )}

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={itemCount === 0 || status === 'importing'}
          className={`w-full mt-3 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all ${
            itemCount === 0 || status === 'importing'
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white active:scale-[0.98] shadow-sm'
          }`}
        >
          {status === 'importing' ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Importing & fetching images...
            </>
          ) : (
            <>
              <Upload size={16} />
              Import {itemCount > 0 ? `${itemCount} ${itemCount === 1 ? 'card' : 'cards'}` : ''}
            </>
          )}
        </button>

        {itemCount > 0 && status === 'idle' && (
          <p className="text-[11px] text-slate-400 mt-2 text-center">
            Image URLs are downloaded (up to 100) &middot; {modifierKeyLabel()}+Enter
          </p>
        )}

        {/* Empty state */}
        {!inputText.trim() && (
          <div className="flex flex-col items-center py-12 px-6 text-center">
            <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mb-5">
              <FileJson size={32} className="text-emerald-300" />
            </div>
            <h3 className="text-lg font-bold text-slate-700 mb-2">Import Pre-built Cards</h3>
            <p className="text-sm text-slate-400 max-w-xs leading-relaxed">
              Paste JSON vocab cards generated by an external AI tool. Cards are saved directly — no AI analysis needed.
            </p>
            <div className="mt-6 space-y-1.5 text-left w-full max-w-xs">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Features:</p>
              {[
                'Accepts simplified or full StoredItem format',
                'Image URLs are downloaded and stored (up to 100 per import)',
                'Single card or array of cards',
              ].map((hint, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 shrink-0" />
                  {hint}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
};
