import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCcw, Trash2, CheckCircle2, Flame, ChevronLeft, ChevronRight, Sparkles, Loader2 } from 'lucide-react';
import { StoredItem, VocabCard } from '../types';
import { SRSAlgorithm } from '../services/srsAlgorithm';
import { updateAfterRating } from '../services/fsrsScheduler';
import { VocabCardDisplay } from './VocabCard';
import { SpeechStyleToggle } from './SpeechStyleToggle';
import { PlaybackSpeedToggle } from './PlaybackSpeedToggle';
import { MasteryBadge, getMasteryColors } from './mastery';
import { stripSentenceMarkers } from '../services/sentenceMarkers';
import { formatTimeUntil } from '../services/studySession';
import { getPlaybackState, pauseCurrent, resumeCurrent } from '../services/lazyTts';
import { useWarmImages } from '../hooks/useWarmImages';
import { useEscapeLayer } from './escapeStack';
import { isKeyboardFocusedControl, isTypingTarget } from './keyboardTarget';
import { useModalFocus } from './Modal';
import { useOverlay } from './overlayStack';
import { resolvePopupShortcut } from './review/popupShortcuts';
import { edgeZoneAt, gutterZoneAt } from './review/readZones';
import { usePopupPlayback } from './review/usePopupPlayback';
import { useSensePages } from './review/useSensePages';
import { ZoneGuides } from './review/ZoneGuides';

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
  onLazyLoadImage?: (itemId: string, imageVersion?: string) => Promise<string | null>;
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
 * P, E, Cmd/Ctrl+1–4, Space; see review/popupShortcuts) and traps Tab; the parent disables the underlying
 * view via interactionLocked. On ≥sm the left/right gutters beside the card are eyes-free read zones (top
 * quarter = example 1, 2nd = example 2), responding to tap or mouse.
 *
 * The pages come from review/useSensePages, the audio from review/usePopupPlayback, and where a tap reads
 * from review/readZones.
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
  // Ahead of the focus effect, so the control that opened the popup is recorded while it has focus.
  useOverlay();
  // Focus the panel on open, keep Tab inside it, and restore focus on close.
  useModalFocus(panelRef);
  const [confirmDel, setConfirmDel] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Turning to another meaning disarms a delete armed on this one.
  const disarmDelete = useCallback(() => setConfirmDel(false), []);

  // Paging to another saved meaning shows its picture at once.
  useWarmImages(items, onLazyLoadImage);

  const { word, current, currentSense, count, idx, goPrev, goNext, loadingSenses } =
    useSensePages(items, initialId, onFetchSenses, disarmDelete);
  const vocab = current?.vocab ?? ({} as VocabCard);
  const currentSaved = current?.kind === 'saved' ? current.item : null;

  const shortcutExamples = useMemo(
    () => (vocab.examples || []).map(s => stripSentenceMarkers(s || '').trim()).filter(Boolean),
    [vocab],
  );

  // E and eyes-free zones intentionally remain capped at the first two examples.
  const examplesList = useMemo(
    () => shortcutExamples.slice(0, 2),
    [shortcutExamples],
  );

  const { speakPopupWord, speakPopupNatural, holdKeepAlive, toggleSpeak, readBothExamples } = usePopupPlayback(examplesList);

  // Auto-pronounce the word on each meaning switch. This MUST run as an effect (after the new sense has
  // committed), not synchronously inside goTo: switching remounts <VocabCardDisplay> via its `key`, and
  // the unmounting <PronunciationBlock> calls speechSynthesis.cancel() in its cleanup. That cancel() and a
  // speakWord() fired right after it land in the same tick — and the Web Speech engine SILENTLY DROPS a
  // speak() that follows too closely on a cancel() (see services/speech.ts), which is why swipe/arrow
  // switches pronounced only intermittently. The short delay lets the cancel settle so the speak sticks
  // every time; the cleanup clears it on a rapid re-switch so only the final sense speaks. Mirrors
  // DetailView's word-card auto-pronounce (same 100ms). Skips the initial open.
  const didOpenRef = useRef(false);
  useEffect(() => {
    if (!didOpenRef.current) { didOpenRef.current = true; return; }
    if (!word) return;
    const t = setTimeout(() => speakPopupWord(word), 100);
    return () => clearTimeout(t);
  }, [currentSense, word, speakPopupWord]);

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
      else if (word) speakPopupWord(word);                     // single meaning → re-pronounce the word
    }
  }, [count, goNext, goPrev, word, speakPopupWord]);

  const mastery = currentSaved
    ? SRSAlgorithm.getMasteryLevel(SRSAlgorithm.ensure(currentSaved.srs, currentSaved.data.id, currentSaved.type))
    : null;
  const colors = getMasteryColors(mastery?.color || 'slate');
  const totalReviews = currentSaved?.srs?.totalReviews ?? 0;
  const streak = currentSaved?.srs?.correctStreak ?? 0;
  const nextReview = currentSaved?.srs?.nextReview ?? 0;
  const now = Date.now();

  const handleGotIt = useCallback(() => {
    if (!currentSaved) return;
    const base = SRSAlgorithm.ensure(currentSaved.srs, currentSaved.data.id, currentSaved.type);
    const preview = updateAfterRating(base, 'good');
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

  // Eyes-free read zones are for touch only — on macOS the keyboard (P / E / Cmd+1–4) covers reading.
  const isTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  // Judge each click by what made it where the browser says, so a mouse or trackpad on a touchscreen
  // laptop (or an iPad's trackpad) still closes from the gutter instead of reading.
  const isTouchClick = useCallback((e: React.MouseEvent) => {
    const type = (e.nativeEvent as Partial<PointerEvent>).pointerType;
    return type ? type !== 'mouse' : isTouch;
  }, [isTouch]);

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
    if (!isTouchClick(e) || window.innerWidth >= 640 || examplesList.length === 0) return;
    if (window.getSelection()?.toString().trim()) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, a, [role="button"], input, textarea, select, label')) return;
    const rect = scrollBodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    const z = edgeZoneAt(rect, e.clientX, e.clientY);
    if (z === null) return;
    if (z < examplesList.length) { toggleSpeak(examplesList[z]); flashZone(z); }
  }, [isTouchClick, examplesList, toggleSpeak, flashZone]);

  // iPad / desktop (≥sm, centered card): tapping the empty LEFT/RIGHT gutter beside the card reads —
  // top quarter → example 1, second quarter → example 2. Anywhere else (and the phone sheet, which has
  // no gutter) closes.
  const onBackdrop = useCallback((e: React.MouseEvent) => {
    if (isTouchClick(e) && window.innerWidth >= 640 && examplesList.length > 0) {
      const rect = panelRef.current?.getBoundingClientRect();
      const z = rect ? gutterZoneAt(rect, window.innerHeight, e.clientX, e.clientY) : null;
      if (z !== null && z < examplesList.length) { toggleSpeak(examplesList[z]); flashZone(z); return; }
    }
    onClose();
  }, [isTouchClick, examplesList, toggleSpeak, flashZone, onClose]);

  // Escape closes the popup, unless a dialog opened above it is still open.
  useEscapeLayer(onClose, 100);

  // Keyboard ownership while open (the parent gates the underlying view via interactionLocked).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolvePopupShortcut(e, {
        typing: isTypingTarget(e.target),
        // Space and Enter press a control the keyboard moved to (Close, Got it, a toggle). A clicked one keeps
        // focus too, but then they are the shortcuts, so a click followed by Space never presses it again.
        onControl: isKeyboardFocusedControl(e.target),
        pageCount: count,
        saved: !!currentSaved,
      });
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'prev': goPrev(); break;
        case 'next': goNext(); break;
        case 'togglePlayback': {
          const st = getPlaybackState().status;
          if (st === 'playing') pauseCurrent();
          else if (st === 'paused') resumeCurrent();
          else if (examplesList[0]) { holdKeepAlive(); speakPopupNatural(examplesList[0], { allowDownload: true }); }
          break;
        }
        case 'pronounce': if (vocab.word) { holdKeepAlive(); speakPopupWord(vocab.word); } break;
        case 'readExample': { const s = shortcutExamples[action.index]; if (s) toggleSpeak(s); break; }
        case 'readBoth': readBothExamples(); break;
        case 'gotIt': handleGotIt(); break;
        case 'reset': handleReset(); break;
        case 'save': handleSaveThis(); break;
        case 'delete': handleDelete(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [vocab, currentSaved, handleGotIt, handleReset, handleDelete, handleSaveThis, examplesList, shortcutExamples, toggleSpeak, readBothExamples, goPrev, goNext, count, holdKeepAlive, speakPopupNatural, speakPopupWord]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center sm:px-16 sm:py-4 fade-in"
      onClick={onBackdrop}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-white w-full h-[90dvh] rounded-t-2xl sm:h-auto sm:max-h-[90dvh] sm:max-w-4xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden outline-none"
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
              <PlaybackSpeedToggle className="bg-slate-100 hover:bg-slate-200" />
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
              <MasteryBadge {...mastery} />
              <div className="hidden sm:block flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                <div className={`h-full ${colors.bar} transition-all duration-300`} style={{ width: `${mastery.percentage}%` }} />
              </div>
              <span className="text-slate-400 whitespace-nowrap">{totalReviews}×</span>
              {streak > 0 && (
                <span className="text-orange-500 flex items-center gap-0.5"><Flame size={12} />{streak}</span>
              )}
              <span className="text-slate-500 whitespace-nowrap">
                {nextReview <= now ? 'due' : formatTimeUntil(nextReview, now)}
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
            <div className="mt-1.5 text-center text-[11px] font-semibold text-emerald-600 fade-in">
              {flash}
            </div>
          )}
        </div>

        {/* Scrollable card body + eyes-free side-edge read zones (touch only) */}
        <div className="flex-1 min-h-0 relative flex flex-col">
          <div
            ref={scrollBodyRef}
            onClick={handleZoneRead}
            className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
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
          {isTouch && examplesList.length > 0 && <ZoneGuides layout="phone" bands={examplesList.length} flash={zoneFlash} />}
        </div>
      </div>

      {/* iPad / desktop (≥sm) gutter read-zone guide — visual only; taps are handled in onBackdrop. */}
      {isTouch && examplesList.length > 0 && <ZoneGuides layout="gutter" bands={examplesList.length} flash={zoneFlash} />}
    </div>
  );
};
