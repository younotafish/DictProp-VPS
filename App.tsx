import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import type { ViewState } from './types';
import { Loader2 } from 'lucide-react';
import { lazyLoadImage } from './services/libraryImages';
import { loginRedirect, type AuthUser } from './services/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { lazyScreen } from './components/lazyScreen';
import { TabScreen } from './components/TabScreen';
import { useOverlay, useOverlayFocusReturn } from './components/overlayStack';
import { AppStatusPills } from './components/AppStatus';
import { connectivityNotice } from './services/connectivityNotice';
import { requestLookup } from './services/searchRequests';
import { useFrozenWhile } from './hooks/useStableValue';
import { warn } from './services/logger';
import { installDebugItems } from './services/debugItems';
import { requestPersistentStorage } from './services/idb';
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
import { useSenseLookup } from './hooks/useSenseLookup';

// The signed-in app re-renders on every library change and progress tick, so the screens, the search sheet,
// the card popup and the navigation are memoized here and re-render only when their own props change; the dialogs
// render only while open. Their code loads on first use, and the ones a tap can open are fetched once the first
// screen is up (see the preload effect in App). So do the screens that stand in for the app when it can't open:
// the sign-in screen and the one for a library this device can't read.
const NotebookView = lazyScreen('notebook', () => import('./views/Notebook').then(module => ({ default: React.memo(module.NotebookView) })));
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
const SignInScreen = lazyScreen('sign-in', () => import('./components/AppGateScreens').then(module => ({ default: module.SignInScreen })));
const LibraryReadFailedScreen = lazyScreen('library-read-failed', () => import('./components/AppGateScreens').then(module => ({ default: module.LibraryReadFailedScreen })));
// The background jobs' pills render only while one shows, and their code loads after the first screen with the rest.
const JobPills = lazyScreen('job-pills', () => import('./components/JobPills').then(module => ({ default: module.JobPills })));
const TAB_SCREENS = {
  notebook: NotebookView,
  study: StudyEnhanced,
  sentences: SentencesView,
  'real-life': RealLifeView,
  essays: EssaysView,
} satisfies Record<ViewState, { preload: () => void }>;

const isTabView = (value: string): value is ViewState => Object.prototype.hasOwnProperty.call(TAB_SCREENS, value);

/** While sign-in is checked or the library is read, and while a screen standing in for the app loads. */
const LoadingScreen: React.FC = () => (
  <div className="fixed inset-0 bg-white flex items-center justify-center">
    <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
  </div>
);

/** The tab showing when the app last closed, or the notebook if there's none or it's gone (the old 'search' tab). */
const readSavedView = (): ViewState => {
  let saved: string | null = null;
  try { saved = localStorage.getItem('app_current_view'); } catch { /* storage unavailable */ }
  return saved !== null && isTabView(saved) ? saved : 'notebook';
};

/**
 * The app for the signed-in account: its library, the tabs, and everything that opens over them. App mounts
 * it per account, so the account id holds for its whole life, and unmounts it if the session lapses: the
 * library's unmount flush then saves it under that account, and signing in again reloads the page.
 */
function SignedInApp({ user }: { user: AuthUser }) {
  const [currentView, setCurrentView] = useState<ViewState>(readSavedView);

  // Persist current view
  useEffect(() => {
    try { localStorage.setItem('app_current_view', currentView); } catch { /* storage full or unavailable */ }
  }, [currentView]);

  const library = useLibrary(user.id);
  const { latestItemsRef } = library;
  const { reviewHistory, flushPendingReviews, undoSRSReview, updateSRS } = useReviewOutbox(user.id, library);
  const { comparisons, handleCompareReady, handleCompare } = useComparisons(user.id);
  const libraryViews = useLibraryViews(library.savedItems);
  const {
    allActiveItems, studyItems, allSentenceItems, realLifeProgressItems, essayProgressItems, sentenceItems,
    sentenceDueCount, isSentenceSaved, isVocabSaved, findSavedByWord, findSavedItem, matchSavedBases,
  } = libraryViews;
  const detail = useDetailView(libraryViews, library);
  const {
    detailContext, liveDetailGroups, liveDetailSentenceItems, closeDetail, removeItemFromDetailContext,
    removeSentenceFromDetailContext, handleViewStoredItem, handleViewSentence, prepareExampleSentence, handleOpenStudyExample,
  } = detail;
  const undo = useUndoOffer(library, detail);
  const { undoMessage, closeUndoOffer, undoLastChange } = undo;
  const { navRef, revealNav, handleScroll, navigate, syncScrollPosition } = useNavBar(currentView, setCurrentView);
  const mainRef = useRef<HTMLElement>(null);
  const overlays = useOverlays(allActiveItems);
  const {
    cardPopup, openCardPopup, closeCardPopup, popupItems, duplicateClusters, setDuplicateClusters, confirmModal, setConfirmModal,
    showKeyboardHelp, setShowKeyboardHelp, openKeyboardHelp, showRefusedReviews, setShowRefusedReviews, openRefusedReviews, dialogOpen, modalOpen,
  } = overlays;

  // The tabs sit under DetailView and the card popup, so their lists skip the reviews made there as they happen.
  // They catch up a second after the reviews stop, while hidden, so closing them doesn't have to.
  const frozen = !!detailContext || !!cardPopup;
  const notebookItems = useFrozenWhile(allActiveItems, frozen, 1_000);
  const shownSentenceItems = useFrozenWhile(sentenceItems, frozen, 1_000);
  const shownRealLifeProgress = useFrozenWhile(realLifeProgressItems, frozen, 1_000);
  const shownEssayProgress = useFrozenWhile(essayProgressItems, frozen, 1_000);
  // A card covers the page from the moment it's opened, also while its code loads behind the spinner or
  // when it crashes, not only once DetailView has registered itself. So does the card popup.
  useOverlay(!!detailContext);
  useOverlay(!!cardPopup && popupItems.length > 0);
  // While anything covers the page, the page and the nav bar are inert; focus comes back when it closes.
  const overlayOpen = useOverlayFocusReturn(mainRef, navRef);

  // The console's item inspector, for diagnosing sync and schedule problems: __debugItems('atlas').
  useEffect(() => installDebugItems(() => latestItemsRef.current), [latestItemsRef]);

  useAppShortcuts(navigate, detail, overlays, { undoMessage, undoLastChange, modalOpen });
  const { isOnline, offlineSettled } = useOnlineStatus();
  const offlineImages = useOfflineImages(library);
  const { imagePrefetchProgress, imageRestoreProgress, stopImageDownload, handleDownloadOfflineImages, handleRestoreImagesToServer } = offlineImages;
  const {
    isLoaded, libraryReadFailed, retryLibraryLoad, openWithServerCopy, syncStatus, libraryWriteFailed, handleForceSync, handleSignOut,
  } = useLibrarySync(user.id, library, { flushPendingReviews, closeUndoOffer, prefetchImages: offlineImages.prefetchImages });

  const speech = useSpeechBackfill(overlays);
  const { ttsGenProgress, ttsGenAbortRef, handleGenerateAllSpeech } = speech;
  const { handleFindDuplicates, handleMergeDuplicates } = useDuplicateMerge(library, overlays);
  const actions = useLibraryActions(library, detail, undo);
  const {
    handleSave, handleAttachSentenceImage, handleDelete, handleArchive, handleRemoveVocabFromPhrase, handleUnarchive,
    patchLiveItem, handleSaveSentence, handleRefreshReplace, resetSRS,
  } = actions;
  const { batchImportProgress, handleBatchImport } = useBatchImport(library, overlays, actions, speech);

  const { fetchSensesForWord, saveVocabSense } = useSenseLookup(handleSave);

  // A look-up asked for on a card, in the card popup, on a tab or in the search's own results: the search
  // (services/searchRequests, components/GlobalSearch) runs it as an expression picked on screen. `context` is the
  // sentence it was picked from, which the search shows above its meanings.
  const handleRecursiveSearch = useCallback((text: string, options?: { context?: string }) => {
    requestLookup({ query: text, source: 'expression', context: options?.context });
  }, []);

  // Refresh: the search runs the AI for a word again even when it's saved (forceAI) and opens the fresh result,
  // so a refresh from a card goes through the search button, not the notebook's own search box.
  const handleRefreshViaGlobal = useCallback((text: string) => {
    requestLookup({ query: text, source: 'expression', forceAI: true });
  }, []);

  // A card or sentence the open view showed that has left the library, deleted on another device, leaves the view.
  // It's stable, so DetailView's memo holds; a local delete has already taken the item out, so this changes nothing.
  const handleRemoveFromView = useCallback((id: string) => {
    removeItemFromDetailContext(id);
    removeSentenceFromDetailContext(id);
  }, [removeItemFromDetailContext, removeSentenceFromDetailContext]);

  if (libraryReadFailed) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <LibraryReadFailedScreen
          onRetry={retryLibraryLoad}
          onReload={() => window.location.reload()}
          onUseServerCopy={openWithServerCopy}
        />
      </Suspense>
    );
  }

  // The library is still being read from this device.
  if (!isLoaded) return <LoadingScreen />;

  return (
    <div className="fixed inset-0 bg-white flex flex-col">
      {/* Each lazy overlay has a boundary of its own, so one whose code is still arriving doesn't hide the
          card or the progress pills already on screen. */}
      {confirmModal && (
        <Suspense fallback={null}>
        <ConfirmModal {...confirmModal} onCancel={() => setConfirmModal(null)} />
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
        userId={user.id}
        onViewRefusedReviews={openRefusedReviews}
        imagePrefetchProgress={imagePrefetchProgress}
        onStopImageDownload={stopImageDownload}
        imageRestoreProgress={imageRestoreProgress}
        jobPills={ttsGenProgress?.isRunning && (
          <Suspense fallback={null}>
            <ErrorBoundary variant="overlay">
              <JobPills ttsGenProgress={ttsGenProgress} onStopSpeechGeneration={() => { ttsGenAbortRef.current = true; }} />
            </ErrorBoundary>
          </Suspense>
        )}
        undoMessage={undoMessage}
        onUndo={undoLastChange}
        writeFailed={libraryWriteFailed}
        offline={offlineSettled}
        offlineChip={connectivityNotice({ offline: offlineSettled, onTab: !detailContext && !cardPopup }) === 'chip'}
        aboveTabBar={!detailContext}
        holdUpdate={!!detailContext || !!cardPopup}
        liftAbovePopup={!!cardPopup && (!!undoMessage || libraryWriteFailed)}
      />

      {detailContext && (
        <Suspense fallback={<div className="fixed inset-0 z-[54] grid place-items-center bg-white"><Loader2 className="animate-spin text-indigo-500" /></div>}>
        <ErrorBoundary
          key={detailContext.openId}
          onReset={closeDetail}
          fallbackMessage="Something went wrong displaying this card. Your data is safe."
        >
          <DetailView
              groups={liveDetailGroups}
              initialGroupIndex={detailContext.groupIndex}
              initialItemIndex={detailContext.itemIndex}
              navigationKey={detailContext.navigationKey}
              sentenceItems={liveDetailSentenceItems}
              onClose={closeDetail}
              onSave={handleSave}
              onPatchItem={patchLiveItem}
              onRemoveFromView={handleRemoveFromView}
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
              onOpenComparison={handleCompare}
              onSaveSentence={handleSaveSentence}
              onOpenExampleSentence={prepareExampleSentence}
              isSentenceSaved={isSentenceSaved}
              isVocabSaved={isVocabSaved}
              onRemoveVocabFromPhrase={handleRemoveVocabFromPhrase}
              findSaved={findSavedItem}
              onOpenCard={openCardPopup}
              interactionLocked={dialogOpen}
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

      <main ref={mainRef} inert={overlayOpen} className="flex-1 relative w-full min-h-0 overflow-hidden focus:outline-none">
        <TabScreen shown={currentView === 'notebook'}>
          <NotebookView
            items={notebookItems}
            onDelete={handleDelete}
            onSearch={handleRecursiveSearch}
            onViewDetail={handleViewStoredItem}
            user={user}
            onSignOut={handleSignOut}
            onViewRefusedReviews={openRefusedReviews}
            syncStatus={syncStatus}
            onScroll={handleScroll}
            onForceSync={handleForceSync}
            isOnline={isOnline}
            offline={offlineSettled}
            matchSavedBases={matchSavedBases}
            onSyncScroll={syncScrollPosition}
            isVocabSaved={isVocabSaved}
            onFindDuplicates={handleFindDuplicates}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            onSave={handleSave}
            onCompare={handleCompare}
            onSaveSentence={handleSaveSentence}
            isSentenceSaved={isSentenceSaved}
            hasOverlay={overlayOpen}
            onBatchImport={handleBatchImport}
            onJSONImported={handleForceSync}
            batchImportProgress={batchImportProgress}
            onGenerateAllSpeech={handleGenerateAllSpeech}
            speechGenerationRunning={!!ttsGenProgress?.isRunning}
            onRestoreImagesToServer={handleRestoreImagesToServer}
            imageRestoreRunning={imageRestoreProgress !== null}
            onDownloadOfflineImages={handleDownloadOfflineImages}
            onShowShortcuts={openKeyboardHelp}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'study'}>
          <StudyEnhanced
            userId={user.id}
            items={studyItems}
            reviewHistory={reviewHistory}
            onReview={updateSRS}
            onUndoReview={undoSRSReview}
            onOpenExampleSentence={handleOpenStudyExample}
            onViewCards={handleViewStoredItem}
            interactionLocked={!!detailContext}
            onScroll={handleScroll}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'sentences'}>
          <SentencesView
            items={shownSentenceItems}
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
            progressItems={shownRealLifeProgress}
            onUpdateSRS={updateSRS}
            isSentenceSaved={isSentenceSaved}
            onScroll={handleScroll}
            findSaved={findSavedItem}
            onOpenCard={openCardPopup}
          />
        </TabScreen>

        <TabScreen shown={currentView === 'essays'}>
          <EssaysView
            userId={user.id}
            onOpenSentence={handleViewSentence}
            progressItems={shownEssayProgress}
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
        aboveTabBar={!detailContext}
        statusHidden={modalOpen}
        onOfferUndo={undo.offerUndoAction}
      />
      </ErrorBoundary>
      </Suspense>

      <Suspense fallback={null}>
        <AppNavigation
          ref={navRef}
          currentView={currentView}
          onNavigate={navigate}
          sentenceDueCount={sentenceDueCount}
          onKeyboardHelp={openKeyboardHelp}
          covered={overlayOpen}
          onFocus={revealNav}
        />
      </Suspense>

      {/* The gestures and shortcuts sheet */}
      <Suspense fallback={null}>
        {showKeyboardHelp && <KeyboardHelpModal onClose={() => setShowKeyboardHelp(false)} />}
      </Suspense>
      <Suspense fallback={null}>
        {showRefusedReviews && (
          <RefusedReviewsDialog userId={user.id} onClose={() => setShowRefusedReviews(false)} />
        )}
      </Suspense>
    </div>
  );
}

const App: React.FC = () => {
  const authState = useAuthState();

  useEffect(() => { void requestPersistentStorage(); }, []);

  // Fetch screen code ahead of use. A screen whose code isn't in yet shows its fallback for at least 300 ms
  // (React holds a fallback that long once it's shown), so the first screen's code is fetched while the
  // library loads, and the code of everything a tap can open once the first screen is up. That's what lets
  // the app, a card, a tab or a popup appear on the first frame. It runs on the sign-in screen too.
  useEffect(() => {
    for (const screen of [TAB_SCREENS[readSavedView()], AppNavigation, GlobalSearch]) screen.preload();
    const preloadRest = () => {
      for (const screen of [
        DetailView, ...Object.values(TAB_SCREENS), CardReviewPopup, ConfirmModal, DuplicatesModal, KeyboardHelpModal,
        RefusedReviewsDialog, SignInScreen, LibraryReadFailedScreen, JobPills,
      ]) {
        screen.preload();
      }
      loadFsrsScheduler().catch(error => warn('The review scheduler will load with the first review:', error));
      import('./services/libraryTools').catch(error => warn('The notebook tools will load when first used:', error));
      import('./services/api/ai').catch(error => warn('The AI client will load with the first lookup:', error));
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preloadRest, { timeout: 2_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preloadRest, 1_000);
    return () => window.clearTimeout(timer);
  }, []);

  // Auth gate: show login/loading before the main app
  if (authState.loading) {
    return <LoadingScreen />;
  }

  if (!authState.user) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <SignInScreen onSignIn={loginRedirect} expired={authState.expired} />
      </Suspense>
    );
  }

  return <SignedInApp key={authState.user.id} user={authState.user} />;
};

export default App;
