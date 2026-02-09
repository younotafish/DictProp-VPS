import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase";
import { log, error as logError } from "./logger";

/**
 * Trigger podcast generation (async).
 * Returns immediately with the podcast ID. The actual generation
 * happens in a Firestore trigger on the backend — the client
 * watches for status updates via the real-time subscription.
 */
export const generatePodcast = async (wordIds?: string[]): Promise<{ id: string }> => {
  if (!functions) {
    throw new Error("Firebase functions not initialized. Check your Firebase configuration.");
  }

  log("[generatePodcast] Triggering podcast generation...", wordIds ? `${wordIds.length} words` : "auto: 30 weakest");

  const generatePodcastFn = httpsCallable(functions, 'generatePodcast', {
    timeout: 60000, // 1 minute — just creates the doc and returns
  });

  try {
    const result = await generatePodcastFn(wordIds ? { wordIds } : {});
    const data = result.data as { id: string; status: string };

    log("[generatePodcast] Podcast queued:", data.id);
    return { id: data.id };
  } catch (error: any) {
    const msg = error.message || '';
    const code = error.code || '';

    logError("[generatePodcast] Failed:", error);

    if (msg.includes('unauthenticated') || code === 'functions/unauthenticated') {
      throw new Error("You must be signed in to generate a podcast.");
    }

    if (msg.includes('failed-precondition') || code === 'functions/failed-precondition') {
      throw new Error(msg || "No vocabulary items found. Add some words to your notebook first.");
    }

    if (msg.includes('invalid-argument') || code === 'functions/invalid-argument') {
      throw new Error(msg || "Invalid request. Maximum 30 words for manual podcast.");
    }

    throw new Error(msg || 'Failed to start podcast generation. Please try again.');
  }
};

/**
 * Delete a podcast (audio file + Firestore doc).
 */
export const deletePodcast = async (podcastId: string): Promise<void> => {
  if (!functions) {
    throw new Error("Firebase functions not initialized.");
  }

  log("[deletePodcast] Deleting podcast:", podcastId);

  const deletePodcastFn = httpsCallable(functions, 'deletePodcast', {
    timeout: 30000,
  });

  try {
    await deletePodcastFn({ podcastId });
    log("[deletePodcast] Deleted:", podcastId);
  } catch (error: any) {
    logError("[deletePodcast] Failed:", error);
    throw new Error(error.message || 'Failed to delete podcast.');
  }
};

/**
 * Retry a failed podcast. Deletes the old doc and re-creates it
 * so the Firestore trigger picks it up again.
 */
export const retryPodcast = async (podcastId: string): Promise<void> => {
  if (!functions) {
    throw new Error("Firebase functions not initialized.");
  }

  log("[retryPodcast] Retrying podcast:", podcastId);

  const retryPodcastFn = httpsCallable(functions, 'retryPodcast', {
    timeout: 30000,
  });

  try {
    await retryPodcastFn({ podcastId });
    log("[retryPodcast] Retry triggered:", podcastId);
  } catch (error: any) {
    logError("[retryPodcast] Failed:", error);
    throw new Error(error.message || 'Failed to retry podcast generation.');
  }
};
