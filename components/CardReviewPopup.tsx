import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCcw, Trash2, CheckCircle2, Flame } from 'lucide-react';
import { StoredItem, VocabCard } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { VocabCardDisplay } from './VocabCard';
import { SpeechStyleToggle } from './SpeechStyleToggle';
import { stripSentenceMarkers } from './HighlightedSentence';
import { speakWord, speakNatural, getPlaybackState, getPlaybackProgress, pauseCurrent, resumeCurrent, stopCurrent } from '../services/neuralTts';

// Mastery → tailwind classes (mirrors getMasteryColors in DetailView; kept local to avoid an export).
const MASTERY_COLORS: Record<string, { bg: string; text: string; bar: string }> = {
  slate: { bg: 'bg-slate-100', text: 'text-slate-600', bar: 'bg-slate-400' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-600', bar: 'bg-orange-400' },
  amber: { bg: 'bg-amber-100', text: 'text-amber-600', bar: 'bg-amber-400' },
  blue: { bg: 'bg-blue-100', text: 'text-blue-600', bar: 'bg-blue-400' },
  emerald: { bg: 'bg-emerald-100', text: 'text-emerald-600', bar: 'bg-emerald-400' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-600', bar: 'bg-purple-400' },
};

const formatRelative = (ts: number): string => {
  const diff = ts - Date.now();
  if (diff <= 0) return 'due';
  const m = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return 'now';
};

interface CardReviewPopupProps {
  item: StoredItem;
  onClose: () => void;
  onUpdateSRS: (id: string) => void;
  onResetSRS: (id: string) => void;
  onDelete: (id: string) => void;
  onSearch?: (term: string) => void;
  onRefresh?: (term: string) => void;
  onCompare?: (words: string[]) => void;
  onSaveSentence?: (text: string, word: string, sense?: string) => void;
  isSentenceSaved?: (text: string) => boolean;
  onLazyLoadImage?: (itemId: string) => Promise<string | null>;
}

/**
 * The full review card for an already-saved word, shown in an overlay — opened by tapping a
 * footnote marker on a saved word inside a sentence. Everything you can do in notebook card-review
 * mode: the rich card (image, defs, forms, family, usage, origins, mnemonic, synonyms, speakers,
 * search/refresh/compare/save-sentence) plus the SRS row (mastery, Got it / Reset / Delete).
 *
 * Reads its `item` live from App state (by id), so Got it / Reset update the bar in place; the
 * parent unmounts the popup when the item is deleted.
 *
 * Cross-device: bottom-sheet on phone, centered modal on tablet/desktop; the header + SRS row are a
 * sticky top bar (only the card body scrolls). While open it owns the FULL word-card keyboard set —
 * Esc (close), R / Shift+R (remember / reset), D (delete), P (pronounce), E (read both examples),
 * Cmd/Ctrl+1·2 (read 1st / 2nd example), Space (play/pause) — and traps Tab; the parent disables the
 * underlying view's shortcuts via interactionLocked. On touch tablets the left/right gutters beside the
 * centered card are eyes-free read zones (top quarter = example 1, second quarter = example 2).
 */
export const CardReviewPopup: React.FC<CardReviewPopupProps> = ({
  item,
  onClose,
  onUpdateSRS,
  onResetSRS,
  onDelete,
  onSearch,
  onRefresh,
  onCompare,
  onSaveSentence,
  isSentenceSaved,
  onLazyLoadImage,
}) => {
  const vocab = item.data as VocabCard;
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const mastery = SRSAlgorithm.getMasteryLevel(SRSAlgorithm.ensure(item.srs, item.data.id, item.type));
  const colors = MASTERY_COLORS[mastery.color] || MASTERY_COLORS.slate;
  const totalReviews = item.srs?.totalReviews ?? 0;
  const streak = item.srs?.correctStreak ?? 0;
  const nextReview = item.srs?.nextReview ?? 0;

  const handleGotIt = useCallback(() => {
    const base = SRSAlgorithm.ensure(item.srs, item.data.id, item.type);
    const preview = SRSAlgorithm.updateAfterRemember(base);
    onUpdateSRS(item.data.id);
    setFlash(`Next review in ${Math.max(1, Math.round(preview.stability))}d`);
    setTimeout(() => setFlash(null), 1600);
  }, [item, onUpdateSRS]);

  const handleReset = useCallback(() => {
    onResetSRS(item.data.id);
    setFlash('Memory reset');
    setTimeout(() => setFlash(null), 1600);
  }, [item, onResetSRS]);

  const handleDelete = useCallback(() => {
    if (!confirmDel) {
      setConfirmDel(true);
      setTimeout(() => setConfirmDel(false), 2500);
      return;
    }
    onDelete(item.data.id);
    onClose();
  }, [confirmDel, item, onDelete, onClose]);

  const isTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  // The card's example sentences (stripped, ≤2) — for the E / Cmd+1·2 readers and the eyes-free zones.
  const examplesList = useMemo(
    () => (vocab.examples || []).slice(0, 2).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean),
    [vocab],
  );

  // Toggle natural-voice playback for one sentence (same clip → pause / resume / restart-near-end),
  // mirroring the word card's toggleSpeak so the speaker icons stay in sync.
  const toggleSpeak = useCallback((raw: string) => {
    const sentence = stripSentenceMarkers(raw || '').trim();
    if (!sentence) return;
    const pb = getPlaybackState();
    if (pb.text === sentence) {
      if (pb.status === 'loading') return;
      if (pb.status === 'paused') { resumeCurrent(); return; }
      if (pb.status === 'playing' && getPlaybackProgress() < 0.85) { pauseCurrent(); return; }
    }
    speakNatural(sentence, { allowDownload: true });
  }, []);

  // E: read both example sentences in turn; press again to pause / resume.
  const readBothExamples = useCallback(() => {
    if (!examplesList.length) return;
    const pb = getPlaybackState();
    if (pb.text && examplesList.includes(pb.text) && (pb.status === 'playing' || pb.status === 'paused')) {
      if (pb.status === 'playing') pauseCurrent(); else resumeCurrent();
      return;
    }
    let idx = 0;
    let handle: ReturnType<typeof speakNatural> | undefined;
    const playNext = () => {
      if (idx >= examplesList.length) return;
      if (handle && !handle.isActive()) return;
      handle = speakNatural(examplesList[idx++], { allowDownload: true, onEnd: () => setTimeout(playNext, 400), onError: () => setTimeout(playNext, 400) });
    };
    playNext();
  }, [examplesList]);

  // Eyes-free zone tap-confirmation flash (mirrors DetailView).
  const [zoneFlash, setZoneFlash] = useState<{ zone: number; n: number } | null>(null);
  const zoneFlashN = useRef(0);
  const zoneFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashZone = useCallback((zone: number) => {
    zoneFlashN.current += 1;
    setZoneFlash({ zone, n: zoneFlashN.current });
    if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current);
    zoneFlashTimer.current = setTimeout(() => setZoneFlash(null), 500);
  }, []);
  useEffect(() => () => { if (zoneFlashTimer.current) clearTimeout(zoneFlashTimer.current); }, []);

  // Backdrop tap: on touch, the LEFT/RIGHT gutter beside the centered card is an eyes-free read zone —
  // its top quarter (of the viewport) reads example 1, the second quarter reads example 2, so on iPad
  // you don't have to hit the card in the middle. Anywhere else (and any mouse click) closes. On the
  // phone bottom-sheet the card is full-width (no gutter), so a backdrop tap just closes.
  const onBackdrop = useCallback((e: React.MouseEvent) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (isTouch && rect && examplesList.length > 0 && (e.clientX < rect.left || e.clientX > rect.right)) {
      const h = window.innerHeight;
      if (e.clientY < h * 0.5) {
        const z = e.clientY < h * 0.25 ? 0 : 1;
        if (z < examplesList.length) { toggleSpeak(examplesList[z]); flashZone(z); return; }
      }
    }
    onClose();
  }, [isTouch, examplesList, toggleSpeak, flashZone, onClose]);

  // Focus the panel on open; restore focus on close.
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => { try { prevFocus?.focus?.(); } catch { /* ignore */ } };
  }, []);

  // Keyboard ownership while open (the parent gates the underlying view via interactionLocked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as HTMLElement).isContentEditable);

      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }

      // Focus trap
      if (e.key === 'Tab') {
        const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
        );
        const list = focusables ? Array.from(focusables).filter(el => el.offsetParent !== null) : [];
        if (list.length === 0) return;
        const first = list[0], last = list[list.length - 1];
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && (active === first || active === panelRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
        return;
      }

      if (typing) return;

      if (e.key === ' ') {
        e.preventDefault();
        const st = getPlaybackState().status;
        if (st === 'playing') pauseCurrent();
        else if (st === 'paused') resumeCurrent();
        else if (examplesList[0]) speakNatural(examplesList[0], { allowDownload: true });
        return;
      }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); if (e.shiftKey) handleReset(); else handleGotIt(); return; }
      if (e.key === 'd' || e.key === 'D') { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); handleDelete(); } return; }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (vocab.word) speakWord(vocab.word); return; }
      // Cmd/Ctrl+1 · +2 → read the 1st / 2nd example sentence (mirrors word-card mode).
      if ((e.metaKey || e.ctrlKey) && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        const s = examplesList[e.key === '1' ? 0 : 1];
        if (s) toggleSpeak(s);
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); readBothExamples(); }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [vocab, onClose, handleGotIt, handleReset, handleDelete, examplesList, toggleSpeak, readBothExamples]);

  // Stop any popup-initiated playback when the card actually closes (not on every re-render).
  useEffect(() => () => { stopCurrent(); }, []);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-[2px] flex items-end sm:items-center justify-center sm:px-16 sm:py-4 animate-in fade-in duration-200"
      onClick={onBackdrop}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-white w-full h-[90vh] rounded-t-2xl sm:h-auto sm:max-h-[90vh] sm:max-w-4xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden outline-none animate-in slide-in-from-bottom sm:zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Review card: ${vocab.word}`}
      >
        {/* Sticky top bar: title + SRS row + actions */}
        <div className="shrink-0 border-b border-slate-200 bg-white px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3 pb-2">
          {/* Title row */}
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0">
              <span className="text-lg font-bold text-slate-800 truncate">{vocab.word}</span>
              {vocab.sense && <span className="ml-2 text-xs text-slate-400">{vocab.sense}</span>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <SpeechStyleToggle />
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </div>
          {/* SRS row */}
          <div className="flex items-center gap-2 text-xs">
            <span className={`${colors.bg} ${colors.text} px-2 py-0.5 rounded-full font-semibold whitespace-nowrap`}>
              {mastery.label} {Math.round(mastery.percentage)}%
            </span>
            <div className="hidden sm:block flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
              <div className={`h-full ${colors.bar} transition-all duration-300`} style={{ width: `${mastery.percentage}%` }} />
            </div>
            <span className="text-slate-400 whitespace-nowrap">{totalReviews}×</span>
            {streak > 0 && (
              <span className="text-orange-500 flex items-center gap-0.5"><Flame size={12} />{streak}</span>
            )}
            <span className="text-slate-500 whitespace-nowrap">
              {nextReview <= Date.now() ? 'due' : formatRelative(nextReview)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button onClick={handleReset} className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors" title="Reset memory (Shift+R)">
                <RotateCcw size={15} />
              </button>
              <button
                onClick={handleDelete}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors ${confirmDel ? 'text-white bg-rose-500 hover:bg-rose-600 font-semibold' : 'text-slate-400 hover:text-rose-600 hover:bg-rose-50'}`}
                title="Delete word (D)"
              >
                <Trash2 size={15} />{confirmDel && <span className="text-xs">Sure?</span>}
              </button>
              <button onClick={handleGotIt} className="flex items-center gap-1 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg transition-colors" title="Remember (R)">
                <CheckCircle2 size={14} /> Got it
              </button>
            </div>
          </div>
          {flash && (
            <div className="mt-1.5 text-center text-[11px] font-semibold text-emerald-600 animate-in fade-in duration-200">
              {flash}
            </div>
          )}
        </div>

        {/* Scrollable card body */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]" style={{ WebkitOverflowScrolling: 'touch' }}>
          <VocabCardDisplay
            data={vocab}
            showSave={false}
            scrollable={false}
            onSearch={onSearch}
            onRefresh={onRefresh}
            onCompare={onCompare}
            onSaveSentence={onSaveSentence}
            isSentenceSaved={isSentenceSaved}
            onLazyLoadImage={onLazyLoadImage}
            className="!h-auto !overflow-visible border-indigo-100 shadow-sm bg-white"
          />
        </div>
      </div>

      {/* Eyes-free read zones in the LEFT/RIGHT gutters beside the centered card (touch + ≥sm only).
          Visual guide only — the taps are handled on the backdrop (onBackdrop): top quarter = example 1,
          second quarter = example 2. Stays out of the card area so middle taps still work normally. */}
      {isTouch && examplesList.length > 0 && (
        <div className="fixed inset-0 z-[101] pointer-events-none hidden sm:block" aria-hidden="true">
          <div className="absolute inset-x-0 top-0 h-[25vh]">
            <div className="absolute left-0 inset-y-3 w-1.5 rounded-full bg-indigo-400/70" />
            <div className="absolute right-0 inset-y-3 w-1.5 rounded-full bg-indigo-400/70" />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-bold flex items-center justify-center shadow-sm">1</span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-bold flex items-center justify-center shadow-sm">1</span>
            {zoneFlash?.zone === 0 && (<><div key={`l${zoneFlash.n}`} className="absolute left-0 inset-y-0 w-16 bg-indigo-400/20 zone-flash" /><div key={`r${zoneFlash.n}`} className="absolute right-0 inset-y-0 w-16 bg-indigo-400/20 zone-flash" /></>)}
          </div>
          {examplesList.length > 1 && (
            <div className="absolute inset-x-0 top-[25vh] h-[25vh]">
              <div className="absolute left-0 inset-y-3 w-1.5 rounded-full bg-emerald-400/70" />
              <div className="absolute right-0 inset-y-3 w-1.5 rounded-full bg-emerald-400/70" />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-[11px] font-bold flex items-center justify-center shadow-sm">2</span>
              <span className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-[11px] font-bold flex items-center justify-center shadow-sm">2</span>
              {zoneFlash?.zone === 1 && (<><div key={`l${zoneFlash.n}`} className="absolute left-0 inset-y-0 w-16 bg-emerald-400/20 zone-flash" /><div key={`r${zoneFlash.n}`} className="absolute right-0 inset-y-0 w-16 bg-emerald-400/20 zone-flash" /></>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
