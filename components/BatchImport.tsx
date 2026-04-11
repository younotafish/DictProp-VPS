import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ProjectInfo } from '../types';
import { X, ClipboardPaste, Trash2, ListPlus, Sparkles } from 'lucide-react';

interface BatchImportProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (words: string[], project?: string) => void;
  projects?: ProjectInfo[];
  activeProject?: string;
}

export const BatchImport: React.FC<BatchImportProps> = ({
  isOpen,
  onClose,
  onSubmit,
  projects = [],
  activeProject,
}) => {
  const [inputText, setInputText] = useState('');
  const [selectedProject, setSelectedProject] = useState<string | undefined>(activeProject);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on open
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [isOpen]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setSelectedProject(activeProject);
    }
  }, [isOpen, activeProject]);

  const parseWords = useCallback((text: string): string[] => {
    return text
      .split(/[\n,;]+/)
      .map(w => w.trim())
      .filter(w => w.length > 0);
  }, []);

  const wordCount = inputText.trim() ? parseWords(inputText).length : 0;

  const handleSubmit = useCallback(() => {
    const words = parseWords(inputText);
    if (words.length === 0) return;
    onSubmit(words, selectedProject);
    setInputText('');
    onClose();
  }, [inputText, parseWords, selectedProject, onSubmit, onClose]);

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
            <ListPlus size={20} className="text-indigo-600" />
            Batch Import
          </h2>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-8">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Paste your word list here — one word or phrase per line.

Examples:
ubiquitous
serendipity
a blessing in disguise
run the gamut"
            className="w-full min-h-[200px] max-h-[400px] p-4 pr-12 bg-slate-50 border border-slate-200 rounded-2xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-y leading-relaxed font-mono"
          />
          <div className="absolute top-2 right-2 flex flex-col gap-1">
            {!inputText && (
              <button onClick={handlePaste} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors" title="Paste">
                <ClipboardPaste size={16} />
              </button>
            )}
            {inputText && (
              <button onClick={() => setInputText('')} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors" title="Clear">
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
            className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
          >
            <option value="">No project (uncategorized)</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {/* Submit Button */}
        <button
          onClick={handleSubmit}
          disabled={wordCount === 0}
          className={`w-full mt-3 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all ${
            wordCount === 0
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white active:scale-[0.98] shadow-sm'
          }`}
        >
          <Sparkles size={16} />
          Import {wordCount > 0 ? `${wordCount} ${wordCount === 1 ? 'word' : 'words'}` : ''}
        </button>

        {wordCount > 0 && (
          <p className="text-[11px] text-slate-400 mt-2 text-center">
            Processing runs in the background &middot; {(navigator as any).userAgentData?.platform === 'macOS' || navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter
          </p>
        )}

        {/* Empty state */}
        {!inputText.trim() && (
          <div className="flex flex-col items-center py-12 px-6 text-center">
            <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-5">
              <ListPlus size={32} className="text-indigo-300" />
            </div>
            <h3 className="text-lg font-bold text-slate-700 mb-2">Batch Import Words</h3>
            <p className="text-sm text-slate-400 max-w-xs leading-relaxed">
              Paste a list of words or phrases. The AI will analyze each one in the background and save all meanings with images to your notebook.
            </p>
            <div className="mt-6 space-y-1.5 text-left w-full max-w-xs">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Separators:</p>
              {['One word/phrase per line', 'Comma-separated: word1, word2', 'Semicolons also work'].map((hint, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-300 shrink-0" />
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
