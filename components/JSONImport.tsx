import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ProjectInfo } from '../types';
import { X, ClipboardPaste, Trash2, FileJson, Upload, AlertCircle, CheckCircle2 } from 'lucide-react';
import { importJSON } from '../services/api';

interface JSONImportProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void; // called after successful import to trigger sync
  projects?: ProjectInfo[];
  activeProject?: string;
}

export const JSONImport: React.FC<JSONImportProps> = ({
  isOpen,
  onClose,
  onImported,
  projects = [],
  activeProject,
}) => {
  const [inputText, setInputText] = useState('');
  const [selectedProject, setSelectedProject] = useState<string | undefined>(activeProject);
  const [status, setStatus] = useState<'idle' | 'importing' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<string>('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setSelectedProject(activeProject);
      setStatus('idle');
      setResult('');
    }
  }, [isOpen, activeProject]);

  const parseItems = useCallback((text: string): { items: any[] | null; error: string | null } => {
    try {
      const parsed = JSON.parse(text.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      // Validate: each item should have at least a 'word' field (simplified) or 'data.id' (full)
      const valid = arr.filter((item: any) =>
        (item && typeof item.word === 'string') ||
        (item && item.data && item.data.id)
      );
      if (valid.length === 0) {
        return { items: null, error: 'No valid items found. Each item needs at least a "word" field.' };
      }
      return { items: valid, error: null };
    } catch (e: any) {
      return { items: null, error: `Invalid JSON: ${e.message}` };
    }
  }, []);

  const itemCount = (() => {
    if (!inputText.trim()) return 0;
    const { items } = parseItems(inputText);
    return items?.length || 0;
  })();

  const handleSubmit = useCallback(async () => {
    const { items, error } = parseItems(inputText);
    if (!items || error) {
      setStatus('error');
      setResult(error || 'Invalid input');
      return;
    }

    setStatus('importing');
    setResult('');

    try {
      const res = await importJSON(items, selectedProject);
      setStatus('done');
      const parts = [`${res.imported} cards imported`];
      if (res.imagesFetched > 0) parts.push(`${res.imagesFetched} images fetched`);
      if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
      setResult(parts.join(' · '));
      onImported();
    } catch (e: any) {
      setStatus('error');
      setResult(e.message || 'Import failed');
    }
  }, [inputText, selectedProject, parseItems, onImported]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInputText(text);
    } catch { /* ignore */ }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col animate-in slide-in-from-bottom duration-300">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 bg-white/90 backdrop-blur-md flex items-center gap-3">
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
        >
          <X size={20} />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <FileJson size={20} className="text-emerald-600" />
            Import JSON
          </h2>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={inputText}
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
            {inputText && (
              <button onClick={() => { setInputText(''); setStatus('idle'); }} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors" title="Clear">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Project picker */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-slate-500 shrink-0">Import to:</span>
          <select
            value={selectedProject || ''}
            onChange={e => setSelectedProject(e.target.value || undefined)}
            className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
          >
            <option value="">No project (uncategorized)</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
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
            Image URLs will be auto-downloaded &middot; {(navigator as any).userAgentData?.platform === 'macOS' || navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter
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
                'Image URLs auto-converted to base64',
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
    </div>
  );
};
