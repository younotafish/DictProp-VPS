import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCcw, Trash2, CheckCircle2, Flame, ChevronLeft, ChevronRight, Sparkles, Loader2 } from 'lucide-react';
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

const senseKey = (s?: string) => (s || '').trim().toLowerCase();

// One page of the popup: a saved sense (with SRS) or an AI sense not yet in the library.
type Page =
  | { kind: 'saved'; item: StoredItem; vocab: VocabCard; sense: string }
  | { kind: 'unsaved'; vocab: VocabCard; sense: string };

interface CardReviewPopupProps {
  /** Every saved sense of the tapped word (≥1). */
  items: StoredItem[];
  /** Which saved sense to open on (defaults to the first). */
  initialId?: string;
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
  /** Fetch the word's full set of AI senses (so we can page through saved + not-yet-saved meanings). */
  onFetchSenses?: (word: string) => Promise<VocabCard[]>;
  /** Save a not-yet-saved sense into the library. */
  onSaveVocab?: (vocab: VocabCard) => void;
}

/**
 * The full review card for a saved word, shown in an overlay — opened by tapping a saved word in a
 * sentence. Pages through ALL of the word's meanings: saved senses (with the SRS row — mastery, Got it /
 * Reset / Delete) plus the word's other AI senses fetched on open (each with a Save button). Switch via
 * ‹ i/N › chips, ←/→ keys, or a horizontal swipe; switching auto-pronounces the word.
 *
 * Cross-device: bottom-sheet on phone, centered modal on tablet/desktop; header + action row are a
 * sticky top bar (only the card body scrolls). It owns the keyboard while open (Esc, ←/→, R/Shift+R, D,
 * P, E, Cmd/Ctrl+1·2, Space) and traps Tab; the parent disables the underlying view via interactionLocked.
 * On ≥sm the left/right gutters beside the card are eyes-free read zones (top quarter = example 1, 2nd =
 * example 2), responding to tap or mouse.
 */
export const CardReviewPopup: React.FC<CardReviewPopupProps> = ({
  items,
  initialId,
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
  onFetchSenses,
  onSaveVocab,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const word = (items[0]?.data as VocabCard)?.word || '';

  // Fetch the word's other AI senses on open (cached per session in App) so we can page saved + unsaved.
  const [aiVocabs, setAiVocabs] = useState<VocabCard[]>([]);
  const [loadingSenses, setLoadingSenses] = useState(false);
  useEffect(() => {
    if (!onFetchSenses || !word) return;
    let alive = true;
    setLoadingSenses(true);
    onFetchSenses(word)
      .then(vs => { if (alive) setAiVocabs(Array.isArray(vs) ? vs : []); })
      .catch(() => { /* offline / failed → just the saved senses */ })
      .finally(() => { if (alive) setLoadingSenses(false); });
    return () => { alive = false; };
  }, [word, onFetchSenses]);

  // Merge saved senses (with SRS) + AI senses not already saved, deduped by sense label.
  const pages = useMemo<Page[]>(() => {
    const seen = new Set<string>();
    const out: Page[] = [];
    for (const it of items) {
      const v = it.data as VocabCard;
      const s = senseKey(v.sense);
      if (!seen.has(s)) { seen.add(s); out.push({ kind: 'saved', item: it, vocab: v, sense: s }); }
    }
    for (const v of aiVocabs) {
      const s = senseKey(v.sense);
      if (!seen.has(s)) { seen.add(s); out.push({ kind: 'unsaved', vocab: v, sense: s }); }
    }
    return out;
  }, [items, aiVocabs]);

  // Track the shown sense by its label so it survives saving/refreshing (an unsaved page becoming saved
  // keeps the same sense), unlike an id which changes when a sense is saved.
  const [currentSense, setCurrentSense] = useState<string>(() => {
    const init = initialId ? items.find(i => i.data.id === initialId) : undefined;
    return senseKey((init?.data as VocabCard)?.sense ?? (items[0]?.data as VocabCard)?.sense);
  });
  const current = pages.find(p => p.sense === currentSense) ?? pages[0];
  useEffect(() => {
    if (current && current.sense !== currentSense) setCurrentSense(current.sense);
  }, [current, currentSense]);

  const vocab = current?.vocab ?? ({} as VocabCard);
  const currentSaved = current?.kind === 'saved' ? current.item : null;

  const count = pages.length;
  const idx = Math.max(0, pages.findIndex(p => p.sense === current?.sense));
  const goTo = useCallback((delta: number) => {
    if (count <= 1) return;
    setConfirmDel(false);
    const next = pages[(((idx + delta) % count) + count) % count];
    setCurrentSense(next.sense);
    if (word) speakWord(word); // auto-pronounce on each switch (matches word-card nav)
  }, [pages, idx, count, word]);
  const goPrev = useCallback(() => goTo(-1), [goTo]);
  const goNext = useCallback(() => goTo(1), [goTo]);

  // Touch: a horizontal swipe across the card pages between senses (when there are multiple). Vertical
  // drags are left to the body's scroll (we only act when the move is clearly horizontal).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const onPanelTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    swipeStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  }, []);
  const onPanelTouchEnd = useCallback((e: React.TouchEvent) => {
    const s = swipeStart.current;
    swipeStart.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (count > 1) { if (dx < 0) goNext(); else goPrev(); } // switch meaning (goTo also pronounces)
      else if (word) speakWord(word);                          // single meaning → re-pronounce the word
    }
  }, [count, goNext, goPrev, word]);

  const mastery = currentSaved
    ? SRSAlgorithm.getMasteryLevel(SRSAlgorithm.ensure(currentSaved.srs, currentSaved.data.id, currentSaved.type))
    : null;
  const colors = mastery ? (MASTERY_COLORS[mastery.color] || MASTERY_COLORS.slate) : MASTERY_COLORS.slate;
  const totalReviews = currentSaved?.srs?.totalReviews ?? 0;
  const streak = currentSaved?.srs?.correctStreak ?? 0;
  const nextReview = currentSaved?.srs?.nextReview ?? 0;

  const handleGotIt = useCallback(() => {
    if (!currentSaved) return;
    const base = SRSAlgorithm.ensure(currentSaved.srs, currentSaved.data.id, currentSaved.type);
    const preview = SRSAlgorithm.updateAfterRemember(base);
    onUpdateSRS(currentSaved.data.id);
    setFlash(`Next review in ${Math.max(1, Math.round(preview.stability))}d`);
    setTimeout(() => setFlash(null), 1600);
  }, [currentSaved, onUpdateSRS]);

  const handleReset = useCallback(() => {
    if (!currentSaved) return;
    onResetSRS(currentSaved.data.id);
    setFlash('Memory reset');
    setTimeout(() => setFlash(null), 1600);
  }, [currentSaved, onResetSRS]);

  const handleDelete = useCallback(() => {
    if (!currentSaved) return;
    if (!confirmDel) {
      setConfirmDel(true);
      setTimeout(() => setConfirmDel(false), 2500);
      return;
    }
    onDelete(currentSaved.data.id);
    setConfirmDel(false);
    if (items.length <= 1) onClose(); // deleted the last SAVED sense → close (unsaved-only has nothing to review)
  }, [confirmDel, currentSaved, items.length, onDelete, onClose]);

  const handleSaveThis = useCallback(() => {
    if (current?.kind !== 'unsaved' || !onSaveVocab) return;
    onSaveVocab(current.vocab);
    setFlash('Saved to your library');
    setTimeout(() => setFlash(null), 1600);
  }, [current, onSaveVocab]);

  // Eyes-free read zones are for touch only — on macOS the keyboard (P / E / Cmd+1·2) covers reading.
  const isTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  // The current sense's example sentences (stripped, ≤2) — for the E / Cmd+1·2 readers and eyes-free zones.
  const examplesList = useMemo(
    () => (vocab.examples || []).slice(0, 2).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean),
    [vocab],
  );

  // Toggle natural-voice playback for one sentence (same clip → pause / resume / restart-near-end).
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
    let i = 0;
    let handle: ReturnType<typeof speakNatural> | undefined;
    const playNext = () => {
      if (i >= examplesList.length) return;
      if (handle && !handle.isActive()) return;
      handle = speakNatural(examplesList[i++], { allowDownload: true, onEnd: () => setTimeout(playNext, 400), onError: () => setTimeout(playNext, 400) });
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

  // PHONE (<sm, full-width sheet): eyes-free read zones on the CARD's left/right EDGES — a tap in the top
  // quarter of either side reads example 1, the second quarter reads example 2. Touch-only; bows out on
  // controls / text selection so the card stays interactive. (≥sm uses the empty gutters — see onBackdrop.)
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const handleZoneRead = useCallback((e: React.MouseEvent) => {
    if (!isTouch || window.innerWidth >= 640 || examplesList.length === 0) return;
    if (window.getSelection()?.toString().trim()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, [role="button"], input, textarea, select, label')) return;
    const rect = scrollBodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = e.clientX - rect.left, relY = e.clientY - rect.top;
    const onSide = relX < rect.width * 0.28 || relX > rect.width * 0.72;
    if (!onSide || relY >= rect.height * 0.5) return;
    const z = relY < rect.height * 0.25 ? 0 : 1;
    if (z < examplesList.length) { toggleSpeak(examplesList[z]); flashZone(z); }
  }, [isTouch, examplesList, toggleSpeak, flashZone]);

  // iPad / desktop (≥sm, centered card): tapping the empty LEFT/RIGHT gutter beside the card reads —
  // top quarter → example 1, second quarter → example 2. Anywhere else (and the phone sheet, which has
  // no gutter) closes.
  const onBackdrop = useCallback((e: React.MouseEvent) => {
    if (isTouch && window.innerWidth >= 640 && examplesList.length > 0) {
      const rect = panelRef.current?.getBoundingClientRect();
      if (rect && (e.clientX < rect.left || e.clientX > rect.right)) {
        const h = window.innerHeight;
        if (e.clientY < h * 0.5) {
          const z = e.clientY < h * 0.25 ? 0 : 1;
          if (z < examplesList.length) { toggleSpeak(examplesList[z]); flashZone(z); return; }
        }
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

      // ← / → page between this word's meanings.
      if (count > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') goPrev(); else goNext();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        const st = getPlaybackState().status;
        if (st === 'playing') pauseCurrent();
        else if (st === 'paused') resumeCurrent();
        else if (examplesList[0]) speakNatural(examplesList[0], { allowDownload: true });
        return;
      }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); if (vocab.word) speakWord(vocab.word); return; }
      // Cmd/Ctrl+1 · +2 → read the 1st / 2nd example sentence.
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
      // Review keys act on a SAVED sense; on an unsaved one R/Enter saves it.
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        if (currentSaved) { if (e.shiftKey) handleReset(); else handleGotIt(); }
        else handleSaveThis();
        return;
      }
      if (e.key === 'Enter') { if (!currentSaved) { e.preventDefault(); handleSaveThis(); } return; }
      if (e.key === 'd' || e.key === 'D') { if (currentSaved && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleDelete(); } return; }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [vocab, currentSaved, onClose, handleGotIt, handleReset, handleDelete, handleSaveThis, examplesList, toggleSpeak, readBothExamples, goPrev, goNext, count]);

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
        onTouchStart={onPanelTouchStart}
        onTouchEnd={onPanelTouchEnd}
        role="dialog"
        aria-modal="true"
        aria-label={`Review card: ${vocab.word}`}
      >
        {/* Sticky top bar: title + action row */}
        <div className="shrink-0 border-b border-slate-200 bg-white px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3 pb-2">
          {/* Title row */}
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0 flex items-baseline gap-2">
              <span className="text-lg font-bold text-slate-800 truncate">{vocab.word}</span>
              {vocab.sense && <span className="text-xs text-slate-400 truncate">{vocab.sense}</span>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {loadingSenses && <Loader2 size={14} className="animate-spin text-slate-300" />}
              {count > 1 && (
                <div className="flex items-center gap-0.5 text-slate-500 mr-1" title="Other meanings of this word (← / →)">
                  <button onClick={goPrev} aria-label="Previous meaning" className="p-1 rounded-lg hover:bg-slate-100 transition-colors"><ChevronLeft size={16} /></button>
                  <span className="text-[11px] font-semibold tabular-nums select-none">{idx + 1}/{count}</span>
                  <button onClick={goNext} aria-label="Next meaning" className="p-1 rounded-lg hover:bg-slate-100 transition-colors"><ChevronRight size={16} /></button>
                </div>
              )}
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
          {/* Action row — SRS for a saved sense, or a Save button for an unsaved AI sense */}
          {currentSaved && mastery ? (
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
                  title="Delete this meaning (D)"
                >
                  <Trash2 size={15} />{confirmDel && <span className="text-xs">Sure?</span>}
                </button>
                <button onClick={handleGotIt} className="flex items-center gap-1 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1.5 rounded-lg transition-colors" title="Remember (R)">
                  <CheckCircle2 size={14} /> Got it
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-400">Not in your library yet</span>
              <button onClick={handleSaveThis} className="ml-auto flex items-center gap-1 text-xs font-bold text-white bg-indigo-500 hover:bg-indigo-600 px-3 py-1.5 rounded-lg transition-colors" title="Save this meaning (R / Enter)">
                <Sparkles size={14} /> Save this meaning
              </button>
            </div>
          )}
          {flash && (
            <div className="mt-1.5 text-center text-[11px] font-semibold text-emerald-600 animate-in fade-in duration-200">
              {flash}
            </div>
          )}
        </div>

        {/* Scrollable card body + eyes-free side-edge read zones (touch only) */}
        <div className="flex-1 min-h-0 relative">
          <div
            ref={scrollBodyRef}
            onClick={handleZoneRead}
            className="absolute inset-0 overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <VocabCardDisplay
              key={current?.sense ?? 'card'}
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
          {/* PHONE side-edge read-zone guide (top quarter = example 1, second = example 2). Visual only;
              taps fall through to the scroll body's handler. Hidden ≥sm (iPad/desktop use the gutters). */}
          {isTouch && examplesList.length > 0 && (
            <div className="absolute inset-0 pointer-events-none sm:hidden" aria-hidden="true">
              <div className="absolute inset-x-0 top-0 h-1/4">
                <div className="absolute left-0 inset-y-2 w-1 rounded-full bg-indigo-400/60" />
                <div className="absolute right-0 inset-y-2 w-1 rounded-full bg-indigo-400/60" />
                <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-bold flex items-center justify-center shadow-sm">1</span>
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-bold flex items-center justify-center shadow-sm">1</span>
                {zoneFlash?.zone === 0 && (<><div key={`l${zoneFlash.n}`} className="absolute left-0 inset-y-0 w-[28%] bg-indigo-400/15 zone-flash" /><div key={`r${zoneFlash.n}`} className="absolute right-0 inset-y-0 w-[28%] bg-indigo-400/15 zone-flash" /></>)}
              </div>
              {examplesList.length > 1 && (
                <div className="absolute inset-x-0 top-1/4 h-1/4">
                  <div className="absolute left-0 inset-y-2 w-1 rounded-full bg-emerald-400/60" />
                  <div className="absolute right-0 inset-y-2 w-1 rounded-full bg-emerald-400/60" />
                  <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-[11px] font-bold flex items-center justify-center shadow-sm">2</span>
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-[11px] font-bold flex items-center justify-center shadow-sm">2</span>
                  {zoneFlash?.zone === 1 && (<><div key={`l${zoneFlash.n}`} className="absolute left-0 inset-y-0 w-[28%] bg-emerald-400/15 zone-flash" /><div key={`r${zoneFlash.n}`} className="absolute right-0 inset-y-0 w-[28%] bg-emerald-400/15 zone-flash" /></>)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* iPad / desktop (≥sm) gutter read-zone guide — visual only; taps are handled in onBackdrop. */}
      {isTouch && examplesList.length > 0 && (
        <div className="fixed inset-0 z-[101] pointer-events-none hidden sm:block" aria-hidden="true">
          <div className="absolute inset-x-0 top-0 h-[25vh]">
            <div className="absolute left-0 inset-y-3 w-1.5 rounded-full bg-indigo-400/70" />
            <div className="absolute right-0 inset-y-3 w-1.5 rounded-full bg-indigo-400/70" />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-bold flex items-center justify-center shadow-sm">1</span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-[11px] font-bold flex items-center justify-center shadow-sm">1</span>
            {zoneFlash?.zone === 0 && (<><div key={`gl${zoneFlash.n}`} className="absolute left-0 inset-y-0 w-16 bg-indigo-400/20 zone-flash" /><div key={`gr${zoneFlash.n}`} className="absolute right-0 inset-y-0 w-16 bg-indigo-400/20 zone-flash" /></>)}
          </div>
          {examplesList.length > 1 && (
            <div className="absolute inset-x-0 top-[25vh] h-[25vh]">
              <div className="absolute left-0 inset-y-3 w-1.5 rounded-full bg-emerald-400/70" />
              <div className="absolute right-0 inset-y-3 w-1.5 rounded-full bg-emerald-400/70" />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-[11px] font-bold flex items-center justify-center shadow-sm">2</span>
              <span className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 text-[11px] font-bold flex items-center justify-center shadow-sm">2</span>
              {zoneFlash?.zone === 1 && (<><div key={`gl${zoneFlash.n}`} className="absolute left-0 inset-y-0 w-16 bg-emerald-400/20 zone-flash" /><div key={`gr${zoneFlash.n}`} className="absolute right-0 inset-y-0 w-16 bg-emerald-400/20 zone-flash" /></>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
