import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { ViewState, getItemSpelling, VocabCard } from './types';
import { Loader2 } from 'lucide-react';
import { getItemContentHash } from './services/itemHash';
import { analyzeInput } from './services/api';
import { lazyLoadImage } from './services/libraryImages';
import { loginRedirect, logout } from './services/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { lazyScreen } from './components/lazyScreen';
import { TabScreen } from './components/TabScreen';
import { AuthLoadingScreen, LibraryReadFailedScreen, PendingApprovalScreen, SignInScreen } from './components/AppGateScreens';
import { takeOverlayOpener, useAnyOverlayOpen } from './components/overlayStack';
import { AppBanners, AppStatusPills } from './components/AppStatus';
import { SRSAlgorithm } from './services/srsAlgorithm';
import { normalizeKey } from './services/wordMatch';
import { useFrozenWhile } from './hooks/useStableValue';
import { warn } from './services/logger';
import { useAuthState } from './hooks/useAuthState';
import { useLibrary } from './hooks/useLibrary';
import { loadFsrsScheduler, useReviewOutbox } from './hooks/useReviewOutbox';
import { useComparisons } from './hooks/useComparisons';
import { useLibraryViews } from './hooks/useLibraryViews';
import { useDetailView } from './hooks/useDetailView';
import { useUndoOffer } from './hooks/useUndoOffer';
import { useNavBar } from './hooks/useNavBar';
import { useOverlays } from './hooks/useOverlays';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useOfflineImages } from './hooks/useOfflineImages';
import { useLibrarySync } from './hooks/useLibrarySync';
import { useSpeechBackfill } from './hooks/useSpeechBackfill';
import { useDuplicateMerge } from './hooks/useDuplicateMerge';
import { useLibraryActions } from './hooks/useLibraryActions';
import { useBatchImport } from './hooks/useBatchImport';

// App re-renders on every library change and progress tick, so the screens and overlays are memoized
// and re-render only when their own props change. Their code loads on first use, and the ones a tap can
// open are fetched once the first screen is up (see the preload effect in App).
const NotebookView = lazyScreen('notebook', () => import('./views/Notebook').then(module => ({ default: module.NotebookView })));
const GlobalSearch = lazyScreen('global-search', () => import('./components/GlobalSearch').then(module => ({ default: React.memo(module.GlobalSearch) })));
const ConfirmModal = lazyScreen('confirm-modal', () => import('./components/ConfirmModal').then(module => ({ default: module.ConfirmModal })));
const DuplicatesModal = lazyScreen('duplicates-modal', () => import('./components/DuplicatesModal').then(module => ({ default: module.DuplicatesModal })));
const CardReviewPopup = lazyScreen('card-review-popup', () => import('./components/CardReviewPopup').then(module => ({ default: React.memo(module.CardReviewPopup) })));
const KeyboardHelpModal = lazyScreen('keyboard-help', () => import('./components/KeyboardHelpModal').then(module => ({ default: module.KeyboardHelpModal })));
const RefusedReviewsDialog = lazyScreen('refused-reviews', () => import('./components/RefusedReviewsDialog').then(module => ({ default: module.RefusedReviewsDialog })));
const StudyEnhanced = lazyScreen('study', () => import('./views/StudyEnhanced').then(module => ({ default: React.memo(module.StudyEnhanced) })));
const AppNavigation = lazyScreen('navigation', () => import('./components/AppNavigation').then(module => ({ default: React.memo(module.default) })));
const SentencesView = lazyScreen('sentences', () => import('./views/SentencesView').then(module => ({ default: React.memo(module.SentencesView) })));
const RealLifeView = lazyScreen('real-life', () => import('./views/RealLifeView').then(module => ({ default: React.memo(module.RealLifeView) })));
const EssaysView = lazyScreen('essays', () => import('./views/EssaysView').then(module => ({ default: React.memo(module.EssaysView) })));
const DetailView = lazyScreen('detail', () => import('./views/DetailView').then(module => ({ default: React.memo(module.DetailView) })));
const TAB_SCREENS = {
  notebook: NotebookView,
  study: StudyEnhanced,
  sentences: SentencesView,
  'real-life': RealLifeView,
  essays: EssaysView,
} satisfies Record<ViewState, { preload: () => void }>;

const App: React.FC = () => {
  const authState = useAuthState();

  useEffect(() => {
    void import('./services/audioCache').then(({ requestPersistentStorage }) => requestPersistentStorage());
  }, []);

  const [currentView, setCurrentView] = useState<ViewState>(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('app_current_view'); } catch { /* storage unavailable */ }
    // Default to notebook, and handle legacy 'search' value from old localStorage
    if (!saved || saved === 'search' || !['notebook', 'study', 'sentences', 'real-life', 'essays'].includes(saved)) {
      return 'notebook';
    }
    return saved as ViewState;
  });

  // Fetch screen code ahead of use. A screen whose code isn't in yet shows its fallback for at least 300 ms
  // (React holds a fallback that long once it's shown), so the first screen's code is fetched while the
  // library loads, and the code of everything a tap can open once the first screen is up. That's what lets
  // the app, a card, a tab or a popup appear on the first frame.
  useEffect(() => {
    for (const screen of [TAB_SCREENS[currentView], AppNavigation, GlobalSearch]) screen.preload();
    const preloadRest = () => {
      for (const screen of [DetailView, ...Object.values(TAB_SCREENS), CardReviewPopup, ConfirmModal, DuplicatesModal, KeyboardHelpModal]) {
        screen.preload();
      }
      loadFsrsScheduler().catch(error => warn('The review scheduler will load with the first review:', error));
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preloadRest, { timeout: 2_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preloadRest, 1_000);
    return () => window.clearTimeout(timer);
  }, []);

  // Persist current view
  useEffect(() => {
    try { localStorage.setItem('app_current_view', currentView); } catch { /* storage full or unavailable */ }
  }, [currentView]);

  const library = useLibrary(authState.user);
  const { latestItemsRef } = library;
  const { reviewHistory, flushPendingReviews, undoSRSReview, updateSRS } = useReviewOutbox(authState.user, library);
  const { comparisons, handleCompareReady, handleCompare, handleOpenComparison } = useComparisons(authState);
  const libraryViews = useLibraryViews(library.savedItems);
  const {
    allActiveItems, studyItems, allSentenceItems, realLifeProgressItems, essayProgressItems, sentenceItems,
    sentenceDueCount, isSentenceSaved, isVocabSaved, findSavedByWord, findSavedItem, hasSavedVariant,
  } = libraryViews;
  const detail = useDetailView(libraryViews, library);
  const {
    detailContext, liveDetailGroups, liveDetailSentenceItems, closeDetail,
    handleViewStoredItem, handleViewSentence, prepareExampleSentence, handleOpenStudyExample,
  } = detail;
  const undo = useUndoOffer(library, detail);
  const { undoMessage, closeUndoOffer, undoLastChange } = undo;
  const { navRef, revealNav, handleScroll } = useNavBar(currentView);
  const mainRef = useRef<HTMLElement>(null);
  const overlays = useOverlays(allActiveItems);
  const {
    cardPopup, openCardPopup, closeCardPopup, popupItems, duplicateClusters, setDuplicateClusters, confirmModal, setConfirmModal,
    showKeyboardHelp, setShowKeyboardHelp, openKeyboardHelp, showRefusedReviews, setShowRefusedReviews, openRefusedReviews,
  } = overlays;

  // The notebook sits under DetailView and the card popup, so it skips the reviews made there as they
  // happen. It catches up a second after they stop, while hidden, so closing them doesn't have to.
  const notebookItems = useFrozenWhile(allActiveItems, !!detailContext || !!cardPopup, 1_000);
  // An open card, popup, dialog or search result covers the tabs and the nav bar, which leave the tab order
  // and the accessibility tree meanwhile (components/overlayStack). Overlays render beside <main>, never in
  // it. When the last one closes, this cleanup runs after the commit that made the page live again, so focus
  // can go back to the control that opened the first; the overlay's own restore ran while it was inert.
  const overlayOpen = useAnyOverlayOpen();
  useEffect(() => {
    if (!overlayOpen) return;
    return () => {
      const opener = takeOverlayOpener();
      const active = document.activeElement;
      const focusLost = !active || active === document.body || !active.isConnected || !!active.closest('[inert]');
      // Not into a text field, where focus would bring up the on-screen keyboard, nor away from anything else.
      if (focusLost && opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]')
        && (mainRef.current?.contains(opener) || navRef.current?.contains(opener))
        && !opener.matches('input, textarea, select, [contenteditable]')) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [overlayOpen]);

  // Debug: expose item inspector for diagnosing per-item sync/SRS issues
  // Call from browser console: __debugItems('atlas') or __debugItems('first half')
  useEffect(() => {
    (window as any).__debugItems = (word: string) => {
      const w = word.toLowerCase().trim();
      const matches = latestItemsRef.current.filter(i => getItemSpelling(i) === w);
      if (matches.length === 0) {
        console.log(`[Debug] No items found for "${word}"`);
        return;
      }
      console.log(`[Debug] Found ${matches.length} item(s) for "${word}":`);
      matches.forEach((item, idx) => {
        console.log(`  [${idx}] id=${item.data.id}, type=${item.type}, deleted=${!!item.isDeleted}, archived=${!!item.isArchived}`);
        console.log(`       SRS: reviews=${item.srs?.totalReviews}, strength=${item.srs?.memoryStrength}, stability=${item.srs?.stability}d, streak=${item.srs?.correctStreak}`);
        console.log(`       lastReview=${item.srs?.lastReviewDate ? new Date(item.srs.lastReviewDate).toISOString() : 'never'}, nextReview=${item.srs?.nextReview ? new Date(item.srs.nextReview).toISOString() : 'N/A'}`);
        console.log(`       updatedAt=${item.updatedAt ? new Date(item.updatedAt).toISOString() : 'N/A'}, savedAt=${new Date(item.savedAt).toISOString()}`);
        console.log(`       lastSyncedHash=${item.lastSyncedHash || 'NONE'}, currentHash=${getItemContentHash(item)}`);
      });
    };
    return () => { delete (window as any).__debugItems; };
  }, []);

  useAppShortcuts(setCurrentView, detail, overlays);
  const { isOnline, showOfflineBanner } = useOnlineStatus();
  const offlineImages = useOfflineImages(library);
  const { imagePrefetchProgress, imageRestoreProgress, stopImageDownload, handleDownloadOfflineImages, handleRestoreImagesToServer } = offlineImages;
  // Signing out from the pending-approval screen needs the server; offline it says so instead of doing nothing.
  const [signOutFailed, setSignOutFailed] = useState(false);
  const {
    isLoaded, libraryReadFailed, retryLibraryLoad, openWithServerCopy, syncStatus, libraryWriteFailed, handleForceSync, handleSignOut,
  } = useLibrarySync(authState.user, library, { flushPendingReviews, closeUndoOffer, prefetchImages: offlineImages.prefetchImages });

  const speech = useSpeechBackfill(overlays);
  const { ttsGenProgress, ttsGenAbortRef, handleGenerateAllSpeech } = speech;
  const { handleFindDuplicates, handleMergeDuplicates } = useDuplicateMerge(library, overlays);
  const actions = useLibraryActions(library, detail, undo);
  const {
    handleSaveRef, handleSave, handleAttachSentenceImage, handleDelete, handleArchive, handleRemoveVocabFromPhrase, handleUnarchive,
    handleSaveSentence, handleRefreshReplace, resetSRS,
  } = actions;
  const { batchImportProgress, handleBatchImport } = useBatchImport(library, overlays, actions, speech);

  const notebookUser = useMemo(() => {
    const user = authState.user;
    return user ? { uid: user.id, displayName: user.displayName, photoURL: user.photoUrl, email: user.email } : null;
  }, [authState.user]);
  // Footnote popup: fetch a word's full set of AI senses (cached per session) so the popup can page
  // through saved + not-yet-saved meanings; and save a chosen sense.
  const senseCacheRef = useRef<Map<string, VocabCard[]>>(new Map());
  const fetchSensesForWord = useCallback(async (word: string): Promise<VocabCard[]> => {
    const key = normalizeKey(word);
    if (!key) return [];
    const cached = senseCacheRef.current.get(key);
    if (cached) return cached;
    try {
      // A marked term is one expression, even when it's several words long.
      const r = await analyzeInput(word, { mode: 'batch' });
      const vocabs = Array.isArray(r?.vocabs) ? (r.vocabs as VocabCard[]) : [];
      senseCacheRef.current.set(key, vocabs);
      return vocabs;
    } catch { return []; }
  }, []);
  const saveVocabSense = useCallback((vocab: VocabCard) => {
    const v: VocabCard = { ...vocab, id: vocab.id || crypto.randomUUID() };
    handleSaveRef.current({ data: v, type: 'vocab', savedAt: Date.now(), srs: SRSAlgorithm.createNew(v.id, 'vocab') });
  }, []);

  // Search handler - triggers GlobalSearch popup (bottom-right search icon)
  const handleRecursiveSearch = useCallback((text: string) => {
      window.dispatchEvent(new CustomEvent('global-search', { detail: { query: text } }));
  }, []);

  // Refresh handler - re-runs the AI for a word through the SAME bottom-right GlobalSearch
  // (forceAI bypasses the saved-card reuse and auto-opens the result). Used by the detail-view
  // refresh button so refreshing routes to the bottom-right icon, not the notebook top bar.
  const handleRefreshViaGlobal = useCallback((text: string) => {
      window.dispatchEvent(new CustomEvent('global-search', { detail: { query: text, forceAI: true } }));
  }, []);

  // Auth gate: show login/pending/loading before the main app
  if (authState.loading) {
    return <AuthLoadingScreen />;
  }

  if (!authState.user) {
    return <SignInScreen onSignIn={loginRedirect} />;
  }

  if (authState.pending) {
    return <PendingApprovalScreen onSignOut={async () => setSignOutFailed(!(await logout()))} signOutFailed={signOutFailed} />;
  }

  if (libraryReadFailed) {
    return (
      <LibraryReadFailedScreen
        onRetry={retryLibraryLoad}
        onReload={() => window.location.reload()}
        onUseServerCopy={openWithServerCopy}
      />
    );
  }

  return (
    <div className="fixed inset-0 bg-white flex flex-col">
      {!isLoaded ? (
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
        </div>
      ) : (
      <>
      <AppBanners showOffline={showOfflineBanner} writeFailed={libraryWriteFailed} isOnline={isOnline} />

      {/* Each lazy overlay has a boundary of its own, so one whose code is still arriving doesn't hide the
          card or the progress pills already on screen. */}
      {confirmModal && (
        <Suspense fallback={null}>
        <ConfirmModal
          isOpen={confirmModal.isOpen}
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          cancelText={confirmModal.cancelText}
          variant={confirmModal.variant}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
          showCancel={confirmModal.showCancel}
        />
        </Suspense>
      )}

      {duplicateClusters && (
        <Suspense fallback={null}>
        <DuplicatesModal
          clusters={duplicateClusters}
          onClose={() => setDuplicateClusters(null)}
          onMerge={handleMergeDuplicates}
        />
        </Suspense>
      )}

      <AppStatusPills
        userId={authState.user?.id}
        onViewRefusedReviews={openRefusedReviews}
        imagePrefetchProgress={imagePrefetchProgress}
        onStopImageDownload={stopImageDownload}
        imageRestoreProgress={imageRestoreProgress}
        ttsGenProgress={ttsGenProgress}
        onStopSpeechGeneration={() => { ttsGenAbortRef.current = true; }}
        undoMessage={undoMessage}
        onUndo={undoLastChange}
      />

      {detailContext && (
        <Suspense fallback={<div className="fixed inset-0 z-[54] grid place-items-center bg-white"><Loader2 className="animate-spin text-indigo-500" /></div>}>
        <ErrorBoundary
          key={detailContext.openId}
          onReset={closeDetail}
          fallbackMessage="Something went wrong displaying this card. Your data is safe — returning to notebook."
        >
          <DetailView
              groups={liveDetailGroups}
              initialGroupIndex={detailContext.groupIndex}
              initialItemIndex={detailContext.itemIndex}
              navigationKey={detailContext.navigationKey}
              sentenceItems={liveDetailSentenceItems}
              onClose={closeDetail}
              onSave={handleSave}
              onDelete={handleDelete}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onResetSRS={resetSRS}
              savedItems={allActiveItems}
              savedSentenceItems={allSentenceItems}
              onSearch={handleRecursiveSearch}
              onRefresh={handleRefreshViaGlobal}
              onLazyLoadImage={lazyLoadImage}
              onUpdateSRS={updateSRS}
              onCompare={handleCompare}
              comparisons={comparisons}
              onOpenComparison={handleOpenComparison}
              onSaveSentence={handleSaveSentence}
              onOpenExampleSentence={prepareExampleSentence}
              isSentenceSaved={isSentenceSaved}
              isVocabSaved={isVocabSaved}
              onRemoveVocabFromPhrase={handleRemoveVocabFromPhrase}
              findSaved={findSavedItem}
              onOpenCard={openCardPopup}
              interactionLocked={!!cardPopup || showKeyboardHelp || !!confirmModal}
              onAttachImage={handleAttachSentenceImage}
          />
        </ErrorBoundary>
        </Suspense>
      )}

      {popupItems.length > 0 && cardPopup && (
        <Suspense fallback={<div className="fixed inset-0 z-[80] grid place-items-center bg-black/5"><Loader2 className="animate-spin text-indigo-500" /></div>}>
          <ErrorBoundary
            key={cardPopup.spelling}
            variant="overlay"
            onReset={closeCardPopup}
            fallbackMessage="This card couldn’t be shown. Your data is safe."
          >
          <CardReviewPopup
              items={popupItems}
              initialId={cardPopup.initialId}
              onClose={closeCardPopup}
              onUpdateSRS={updateSRS}
              onResetSRS={resetSRS}
              onDelete={handleDelete}
              onSearch={handleRecursiveSearch}
              onRefresh={handleRefreshViaGlobal}
              onCompare={handleCompare}
              onSaveSentence={handleSaveSentence}
              isSentenceSaved={isSentenceSaved}
              onLazyLoadImage={lazyLoadImage}
              onFetchSenses={fetchSensesForWord}
              onSaveVocab={saveVocabSense}
          />
          </ErrorBoundary>
        </Suspense>
      )}

      <main ref={mainRef} inert={overlayOpen} className="flex-1 relative w-full min-h-0 overflow-hidden">
        <TabScreen shown={currentView === 'notebook'}>
          <NotebookView
            items={notebookItems}
            onDelete={handleDelete}
            onSearch={handleRecursiveSearch}
            onViewDetail={handleViewStoredItem}
            user={notebookUser}
            onSignIn={loginRedirect}
            onSignOut={handleSignOut}
            syncStatus={syncStatus}
            onScroll={handleScroll}
            onForceSync={handleForceSync}
            isOnline={isOnline}
            hasSavedVariant={hasSavedVariant}
            isVocabSaved={isVocabSaved}
            onFindDuplicates={handleFindDuplicates}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onSave={handleSave}
            onCompare={handleCompare}
            onSaveSentence={handleSaveSentence}
            isSentenceSaved={isSentenceSaved}
            hasOverlay={!!detailContext || !!confirmModal || showKeyboardHelp || !!cardPopup}
            onBatchImport={handleBatchImport}
            onJSONImported={handleForceSync}
            batchImportProgress={batchImportProgress}
            onGenerateAllSpeech={handleGenerateAllSpeech}
            ttsGenProgress={ttsGenProgress}
            onRestoreImagesToServer={handleRestoreImagesToServer}
            imageRestoreRunning={imageRestoreProgress !== null}
            onDownloadOfflineImages={handleDownloadOfflineImages}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'study'}>
          <StudyEnhanced
            items={studyItems}
            reviewHistory={reviewHistory}
            onReview={updateSRS}
            onUndoReview={undoSRSReview}
            onOpenExampleSentence={handleOpenStudyExample}
            interactionLocked={!!detailContext}
            onScroll={handleScroll}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'sentences'}>
          <SentencesView
            items={sentenceItems}
            onUpdateSRS={updateSRS}
            onDelete={handleDelete}
            onSearch={handleRecursiveSearch}
            onScroll={handleScroll}
            onOpenSentence={handleViewSentence}
            findSaved={findSavedItem}
            onOpenCard={openCardPopup}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'real-life'}>
          <RealLifeView
            onOpenSentence={handleViewSentence}
            progressItems={realLifeProgressItems}
            onUpdateSRS={updateSRS}
            isSentenceSaved={isSentenceSaved}
            onScroll={handleScroll}
            findSaved={findSavedItem}
            onOpenCard={openCardPopup}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'essays'}>
          <EssaysView
            onOpenSentence={handleViewSentence}
            progressItems={essayProgressItems}
            onScroll={handleScroll}
          />
        </TabScreen>
      </main>

      <Suspense fallback={null}>
      <ErrorBoundary variant="overlay" fallbackMessage="The search hit an unexpected error. Your data is safe, and closing this starts the search afresh.">
      <GlobalSearch
        onSave={handleSave}
        isVocabSaved={isVocabSaved}
        findSavedByWord={findSavedByWord}
        onSearch={handleRecursiveSearch}
        isOnline={isOnline}
        onLazyLoadImage={lazyLoadImage}
        onRefreshReplace={handleRefreshReplace}
        onSaveSentence={handleSaveSentence}
        isSentenceSaved={isSentenceSaved}
        onCompareReady={handleCompareReady}
        onCompare={handleCompare}
        sentenceItems={sentenceItems}
        onOpenSentence={handleViewSentence}
      />
      </ErrorBoundary>
      </Suspense>

      <Suspense fallback={null}>
        <AppNavigation
          ref={navRef}
          currentView={currentView}
          onNavigate={setCurrentView}
          sentenceDueCount={sentenceDueCount}
          onKeyboardHelp={openKeyboardHelp}
          covered={overlayOpen}
          onFocus={revealNav}
        />
      </Suspense>

      {/* Keyboard Shortcuts Help Modal */}
      <Suspense fallback={null}>
        {showKeyboardHelp && <KeyboardHelpModal onClose={() => setShowKeyboardHelp(false)} />}
      </Suspense>
      <Suspense fallback={null}>
        {showRefusedReviews && authState.user && (
          <RefusedReviewsDialog userId={authState.user.id} onClose={() => setShowRefusedReviews(false)} />
        )}
      </Suspense>
      </>
      )}
    </div>
  );
};

export default App;
