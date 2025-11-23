
import { initializeApp, FirebaseApp } from "firebase/app";
import { 
  getAuth, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
  signInAnonymously,
  GoogleAuthProvider, 
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
  Auth
} from "firebase/auth";
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc,
  deleteDoc,
  collection,
  onSnapshot,
  writeBatch,
  Firestore
} from "firebase/firestore";
import {
  getStorage,
  ref,
  uploadString,
  getDownloadURL,
  deleteObject,
  FirebaseStorage
} from "firebase/storage";
import { StoredItem, TaskPerformance } from "../types";

const CONFIG_KEY = 'popdict_firebase_config';

// Default Configuration (Provided by User)
const DEFAULT_CONFIG = {
  apiKey: "AIzaSyA0JgY0hTlnXZSVg3WQGfKhVm7ij0sTy-s",
  authDomain: "dictpropstore.firebaseapp.com",
  projectId: "dictpropstore",
  storageBucket: "dictpropstore.firebasestorage.app",
  messagingSenderId: "340564794762",
  appId: "1:340564794762:web:23e2bb5a14c9f8c8d43c73"
};

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let storage: FirebaseStorage | undefined;

// Initialize Firebase
try {
    let config = DEFAULT_CONFIG;

    // 1. Check for overrides in Local Storage
    const storedConfig = localStorage.getItem(CONFIG_KEY);
    if (storedConfig) {
        try {
            const parsed = JSON.parse(storedConfig);
            if (parsed.apiKey && parsed.projectId) {
                config = parsed;
            }
        } catch (e) {
            console.warn("Invalid stored config, reverting to default.");
        }
    }

    // 2. Initialize
    app = initializeApp(config);
    auth = getAuth(app);
    db = getFirestore(app);
    storage = getStorage(app);
} catch (e) {
    console.error("Failed to initialize Firebase", e);
}

// 2. Helper to check status
export const isConfigured = () => !!app;

// New Helper for App to check safely
export const isFirebaseInitialized = () => !!auth && !!db;

// 3. Helper to save config and reload
export const saveConfig = (config: any) => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.location.reload(); // Reload to re-initialize
};

export const resetConfig = () => {
    localStorage.removeItem(CONFIG_KEY);
    window.location.reload();
};

// 4. Auth Functions
const provider = new GoogleAuthProvider();

// Helper to detect iOS Safari
const isIOsSafari = (): boolean => {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isStandalone = (window.navigator as any).standalone === true;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isIOS && (isSafari || isStandalone);
};

export const signIn = async () => {
  if (!auth) throw new Error("NOT_CONFIGURED");
  try {
    // iOS Safari has issues with popups, use redirect instead
    if (isIOsSafari()) {
      console.log("iOS Safari detected, using redirect method");
      await signInWithRedirect(auth, provider);
      // The actual sign-in will complete when the page reloads
      // handleRedirectResult should be called on app initialization
    } else {
      await signInWithPopup(auth, provider);
    }
  } catch (error: any) {
    // Suppress console noise for expected operational errors
    const code = error.code || '';
    if (
        code === 'auth/unauthorized-domain' || 
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request'
    ) {
        throw error; // Re-throw for UI to handle, but don't console.error
    }
    
    console.error("Error signing in", error);
    throw error;
  }
};

// Handle redirect result (call this on app initialization for iOS)
export const handleRedirectResult = async () => {
  if (!auth) return null;
  try {
    const result = await getRedirectResult(auth);
    if (result) {
      console.log("Redirect sign-in successful", result.user.uid);
    }
    return result;
  } catch (error: any) {
    const code = error.code || '';
    if (code === 'auth/unauthorized-domain') {
      throw error;
    }
    console.error("Error handling redirect result", error);
    return null;
  }
};

export const signInAnonymouslyUser = async () => {
  if (!auth) throw new Error("NOT_CONFIGURED");
  try {
    await signInAnonymously(auth);
  } catch (error: any) {
    console.error("Error signing in anonymously", error);
    throw error;
  }
};

export const signOut = async () => {
  if (!auth) return;
  try {
    await firebaseSignOut(auth);
  } catch (error) {
    console.error("Error signing out", error);
  }
};

export const subscribeToAuth = (callback: (user: User | null) => void) => {
  if (!auth) {
      callback(null);
      return () => {};
  }
  return onAuthStateChanged(auth, callback);
};

// 5. Data Functions - SUBCOLLECTION ARCHITECTURE

export const subscribeToUserData = (
  userId: string, 
  onData: (items: StoredItem[]) => void
) => {
  if (!db) return () => {};
  
  // Listen to the 'items' subcollection
  const itemsCollection = collection(db, "users", userId, "items");
  
  console.log("🔥 Firebase: Subscribing to updates for user:", userId);

  // OPTIMIZATION: Throttle snapshot processing to avoid rapid re-renders
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSnapshot: any = null;
  
  const processSnapshot = (snapshot: any) => {
    const items: StoredItem[] = [];
    snapshot.forEach((doc: any) => {
        const data = doc.data() as StoredItem;
        // Only include non-deleted items (deleted items shouldn't be in Firestore anyway)
        if (!data.isDeleted) {
          items.push(data);
        }
    });
    
    console.log(`🔥 Firebase: Parsed ${items.length} active items from cloud (${snapshot.metadata.fromCache ? 'cache' : 'server'})`);
    onData(items);
  };

  return onSnapshot(itemsCollection, (snapshot) => {
    // Log metadata for debugging
    console.log("🔥 Firebase: Snapshot received, fromCache:", snapshot.metadata.fromCache, "size:", snapshot.size);

    // OPTIMIZATION: Skip processing if this is just a cache snapshot and we already processed it
    if (snapshot.metadata.fromCache && snapshot.metadata.hasPendingWrites) {
      console.log("🔥 Firebase: Skipping cache snapshot with pending writes");
      return;
    }
    
    // Throttle processing to once per 2 seconds
    pendingSnapshot = snapshot;
    
    if (!throttleTimer) {
      processSnapshot(snapshot);
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (pendingSnapshot && pendingSnapshot !== snapshot) {
          processSnapshot(pendingSnapshot);
        }
        pendingSnapshot = null;
      }, 2000) as ReturnType<typeof setTimeout>;
    }
  }, (error) => {
      console.error("🔥 Firestore subscription error:", error);
      console.error("🔥 Firestore: Error code:", error.code, "Message:", error.message);
  });
};

// Helper: Upload base64 image to Storage and return download URL
const uploadImageToStorage = async (userId: string, itemId: string, imageData: string, imageType: 'main' | 'vocab', vocabIndex?: number): Promise<string | null> => {
  if (!storage || !imageData || !imageData.startsWith('data:image/')) {
    return null;
  }
  
  try {
    // Create unique path for the image
    const timestamp = Date.now();
    const suffix = imageType === 'vocab' ? `_vocab${vocabIndex}` : '';
    const imagePath = `users/${userId}/items/${itemId}${suffix}_${timestamp}.png`;
    const imageRef = ref(storage, imagePath);
    
    // Upload base64 string
    await uploadString(imageRef, imageData, 'data_url');
    
    // Get download URL
    const downloadURL = await getDownloadURL(imageRef);
    console.log(`🔥 Storage: Uploaded image to ${imagePath}`);
    return downloadURL;
  } catch (error) {
    console.error('🔥 Storage: Upload failed:', error);
    return null;
  }
};

// Helper: Process item images and upload to Storage (OPTIMIZED)
const processItemImages = async (userId: string, item: StoredItem): Promise<StoredItem> => {
  const processedItem = JSON.parse(JSON.stringify(item));
  
  if (!processedItem.data) return processedItem;
  
  // Process main image (for vocab cards or phrases)
  // ONLY upload if it's a base64 string (not already a URL)
  if (processedItem.data.imageUrl && processedItem.data.imageUrl.startsWith('data:image/')) {
    const downloadURL = await uploadImageToStorage(userId, processedItem.data.id, processedItem.data.imageUrl, 'main');
    if (downloadURL) {
      processedItem.data.imageUrl = downloadURL;
    } else {
      // If upload failed, remove the base64 to avoid syncing large data
      delete processedItem.data.imageUrl;
    }
  }
  // If already a URL (https://...), keep it as-is
  
  // Process vocab images (for phrases)
  if (processedItem.type === 'phrase' && Array.isArray(processedItem.data.vocabs)) {
    for (let i = 0; i < processedItem.data.vocabs.length; i++) {
      const vocab = processedItem.data.vocabs[i];
      // ONLY upload if it's a base64 string
      if (vocab.imageUrl && vocab.imageUrl.startsWith('data:image/')) {
        const downloadURL = await uploadImageToStorage(userId, processedItem.data.id, vocab.imageUrl, 'vocab', i);
        if (downloadURL) {
          processedItem.data.vocabs[i].imageUrl = downloadURL;
        } else {
          // If upload failed, remove the base64
          delete processedItem.data.vocabs[i].imageUrl;
        }
      }
      // If already a URL, keep it as-is
    }
  }
  
  return processedItem;
};

export const saveUserData = async (userId: string, items: StoredItem[]) => {
  if (!db || !userId) return;
  
  try {
    // Separate active and deleted items
    const activeItems = items.filter(item => !item.isDeleted);
    const deletedItems = items.filter(item => item.isDeleted);
    
    // OPTIMIZATION: Limit batch size to avoid excessive writes
    // Firestore allows 500 ops/batch, but we limit to 100 for cost control
    const MAX_BATCH_SIZE = 100;
    const MAX_DELETES_PER_SYNC = 20;
    
    if (activeItems.length === 0 && deletedItems.length === 0) {
        console.log("🔥 Firebase: No changes to sync");
        return;
    }

    // Update Parent Document (reduced frequency check)
    const userDocRef = doc(db, "users", userId);
    await setDoc(userDocRef, { 
        lastSynced: Date.now()
    }, { merge: true });

    const totalBatches = Math.ceil(Math.max(activeItems.length / MAX_BATCH_SIZE, deletedItems.length / MAX_DELETES_PER_SYNC));
    let writeCountTotal = 0;
    let deleteCountTotal = 0;

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const writeStart = batchIndex * MAX_BATCH_SIZE;
      const deleteStart = batchIndex * MAX_DELETES_PER_SYNC;
      
      const itemsToWrite = activeItems.slice(writeStart, writeStart + MAX_BATCH_SIZE);
      const itemsToDelete = deletedItems.slice(deleteStart, deleteStart + MAX_DELETES_PER_SYNC);

      if (itemsToWrite.length === 0 && itemsToDelete.length === 0) {
        continue;
      }

      console.log(`🔥 Firebase: Syncing batch ${batchIndex + 1}/${totalBatches} -> ${itemsToWrite.length} writes, ${itemsToDelete.length} deletes`);

      // Process images: upload base64 to Storage and replace with URLs
      // This is sequential to avoid overwhelming the connection
      const processedItems: StoredItem[] = [];
      for (const item of itemsToWrite) {
        if (item.data && item.data.id) {
          const processedItem = await processItemImages(userId, item);
          processedItems.push(processedItem);
        }
      }

      const batch = writeBatch(db);
      let batchWriteCount = 0;
      let batchDeleteCount = 0;
      
      processedItems.forEach(item => {
          if (item.data && item.data.id) {
              const docRef = doc(db, "users", userId, "items", item.data.id);
              batch.set(docRef, item);
              batchWriteCount++;
          }
      });
      
      itemsToDelete.forEach(item => {
          if (item.data && item.data.id) {
              const docRef = doc(db, "users", userId, "items", item.data.id);
              batch.delete(docRef);
              batchDeleteCount++;
          }
      });

      if (batchWriteCount > 0 || batchDeleteCount > 0) {
          await batch.commit();
          console.log(`🔥 Firebase: ✅ Batch ${batchIndex + 1} committed (${batchWriteCount} writes, ${batchDeleteCount} deletes)`);
          writeCountTotal += batchWriteCount;
          deleteCountTotal += batchDeleteCount;
      }
    }

    console.log(`🔥 Firebase: ✅ Sync complete! Total writes: ${writeCountTotal}, deletes: ${deleteCountTotal}`);
  } catch (e: any) {
    console.error("🔥 Firebase: ❌ Error saving to cloud:", e);
    console.error("🔥 Firebase: Error details:", e.message, "Code:", e.code);
    if (e.code === 'permission-denied') {
        console.error("🔥 Firebase: ⚠️  Check Firestore Rules!");
        throw new Error("Permission denied. Check database rules.");
    }
    throw e;
  }
};

// ========== LEARNING ANALYTICS SYNC ==========

export interface LearningAnalytics {
  userId: string;
  totalReviews: number;
  totalStudyTime: number; // milliseconds
  streak: number; // days
  lastStudyDate: number; // timestamp
  performanceByTask: {
    [taskType: string]: {
      attempts: number;
      correct: number;
      averageResponseTime: number;
    };
  };
  weakWords: string[]; // IDs of words user struggles with
  strongWords: string[]; // IDs of mastered words
  dailyActivity: {
    [date: string]: {
      reviews: number;
      studyTime: number;
      accuracy: number;
    };
  };
}

/**
 * Save learning analytics to Firebase
 */
export const saveLearningAnalytics = async (userId: string, analytics: LearningAnalytics): Promise<void> => {
  if (!db) throw new Error("NOT_CONFIGURED");
  
  try {
    const analyticsRef = doc(db, "users", userId, "analytics", "summary");
    await setDoc(analyticsRef, {
      ...analytics,
      lastUpdated: Date.now()
    }, { merge: true });
    
    console.log("🔥 Firebase: Learning analytics saved");
  } catch (error) {
    console.error("🔥 Firebase: Error saving analytics:", error);
    throw error;
  }
};

/**
 * Load learning analytics from Firebase
 */
export const loadLearningAnalytics = async (userId: string): Promise<LearningAnalytics | null> => {
  if (!db) throw new Error("NOT_CONFIGURED");
  
  try {
    const analyticsRef = doc(db, "users", userId, "analytics", "summary");
    const snapshot = await getDoc(analyticsRef);
    
    if (snapshot.exists()) {
      return snapshot.data() as LearningAnalytics;
    }
    return null;
  } catch (error) {
    console.error("🔥 Firebase: Error loading analytics:", error);
    return null;
  }
};

/**
 * Subscribe to learning analytics updates
 */
export const subscribeToAnalytics = (
  userId: string,
  onData: (analytics: LearningAnalytics | null) => void
): (() => void) => {
  if (!db) return () => {};
  
  const analyticsRef = doc(db, "users", userId, "analytics", "summary");
  
  return onSnapshot(analyticsRef, (snapshot) => {
    if (snapshot.exists()) {
      onData(snapshot.data() as LearningAnalytics);
    } else {
      onData(null);
    }
  }, (error) => {
    console.error("🔥 Firebase: Analytics subscription error:", error);
  });
};

/**
 * Record a study session (for streak and activity tracking)
 */
export const recordStudySession = async (
  userId: string,
  sessionData: {
    reviews: number;
    studyTime: number;
    accuracy: number;
  }
): Promise<void> => {
  if (!db) throw new Error("NOT_CONFIGURED");
  
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const sessionRef = doc(db, "users", userId, "sessions", today);
    
    await setDoc(sessionRef, {
      ...sessionData,
      timestamp: Date.now()
    }, { merge: true });
    
    console.log("🔥 Firebase: Study session recorded for", today);
  } catch (error) {
    console.error("🔥 Firebase: Error recording session:", error);
  }
};
