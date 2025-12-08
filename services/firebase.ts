import { initializeApp, FirebaseApp } from "firebase/app";
import { 
  getAuth, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
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
  getDocs,
  collection,
  onSnapshot,
  writeBatch,
  Firestore
} from "firebase/firestore";
import { getFunctions, Functions } from "firebase/functions";
import { StoredItem } from "../types";

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
let functions: Functions | undefined;

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
    functions = getFunctions(app);
} catch (e) {
    console.error("Failed to initialize Firebase", e);
}

export { functions };


// 2. Helper to check status
export const isConfigured = () => !!app;

// Auth Functions
const provider = new GoogleAuthProvider();

// Helper to detect iOS Safari
const isIOsSafari = (): boolean => {
  const ua = navigator.userAgent;
  // EXCLUDE iPad from forced redirect. iPads work well with popups (desktop-class browsing).
  const isSmallIOS = /iPhone|iPod/.test(ua);
  const isStandalone = (window.navigator as any).standalone === true;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isSmallIOS && (isSafari || isStandalone);
};

export const signIn = async () => {
  if (!auth) throw new Error("NOT_CONFIGURED");
  try {
    // iOS Safari on iPhone has issues with popups, use redirect instead
    if (isIOsSafari()) {
      console.log("iOS Safari (iPhone) detected, using redirect method");
      // Set flag to detect silent failures (e.g. Cross-Site Tracking)
      localStorage.setItem('auth_redirect_pending', 'true');
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
    const wasPending = localStorage.getItem('auth_redirect_pending');
    
    if (result) {
      console.log("Redirect sign-in successful", result.user.uid);
      localStorage.removeItem('auth_redirect_pending');
    } else if (wasPending) {
       // We expected a result but got none. This usually means the redirect flow failed silently.
       console.warn("Redirect sign-in returned null despite pending flag. Likely Cross-Site Tracking issue.");
       localStorage.removeItem('auth_redirect_pending');
       // We can throw an error here to inform the UI, or just log it.
       // Throwing allows the UI to show a "Try disabling Cross-Site Tracking" hint.
       throw new Error("REDIRECT_FAILED_SILENTLY"); 
    }
    return result;
  } catch (error: any) {
    localStorage.removeItem('auth_redirect_pending');
    const code = error.code || '';
    if (code === 'auth/unauthorized-domain') {
      throw error;
    }
    if (error.message === "REDIRECT_FAILED_SILENTLY") {
        console.error("Redirect failed silently (likely Safari privacy settings)");
        throw error;
    }
    console.error("Error handling redirect result", error);
    return null;
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

export const loadUserData = async (userId: string): Promise<StoredItem[]> => {
  if (!db) throw new Error("NOT_CONFIGURED");
  
  try {
    const itemsCollection = collection(db, "users", userId, "items");
    const snapshot = await getDocs(itemsCollection);
    
    const items: StoredItem[] = [];
    snapshot.forEach((doc: any) => {
        const data = doc.data() as StoredItem;
        items.push(data);
    });
    
    console.log(`🔥 Firebase: Manual fetch retrieved ${items.length} items (including deleted)`);
    return items;
  } catch (error) {
    console.error("🔥 Firebase: Error loading user data:", error);
    throw error;
  }
};

/**
 * Fetch a single item from Firebase by ID
 * Used for lazy-loading images that exist in cloud but not locally
 */
export const loadSingleItem = async (userId: string, itemId: string): Promise<StoredItem | null> => {
  if (!db) return null;
  
  try {
    const docRef = doc(db, "users", userId, "items", itemId);
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      return docSnap.data() as StoredItem;
    }
    return null;
  } catch (error) {
    console.error("🔥 Firebase: Error loading single item:", error);
    return null;
  }
};

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
        items.push(data);
    });
    
    console.log(`🔥 Firebase: Parsed ${items.length} items from cloud (${snapshot.metadata.fromCache ? 'cache' : 'server'})`);
    onData(items);
  };

  const unsubscribe = onSnapshot(itemsCollection, (snapshot) => {
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

  // Return cleanup function that clears throttle timer and unsubscribes
  return () => {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    pendingSnapshot = null;
    unsubscribe();
  };
};

/**
 * Prepare item for Firestore by converting blob IDs to base64 and stripping oversized images.
 * Images stored as blobs locally need to be converted to base64 for cloud sync.
 * Oversized images (>800KB) are stripped to stay within Firestore's 1MB document limit.
 */
/**
 * Strip oversized images from item to fit within Firestore 1MB document limit.
 * Images are kept in local IndexedDB but stripped for cloud sync if too large.
 */
const prepareItemForFirestore = (item: StoredItem): StoredItem => {
  // Firestore limit is 1MB (1,048,576 bytes), but we use 800KB as safe threshold
  const MAX_IMAGE_SIZE = 800 * 1024; // 800KB per image
  const MAX_DOC_SIZE = 900 * 1024; // 900KB total document
  
  // Deep clone to avoid mutating original
  const cloned = JSON.parse(JSON.stringify(item)) as StoredItem;
  const data = cloned.data as any;
  
  // Check main image size - delete field instead of setting undefined (Firestore rejects undefined)
  if (data.imageUrl && data.imageUrl.startsWith('data:image/')) {
    const imageSize = data.imageUrl.length * 0.75; // Base64 is ~4/3 of actual bytes
    if (imageSize > MAX_IMAGE_SIZE) {
      console.warn(`🔥 Firebase: Stripping oversized image (${Math.round(imageSize/1024)}KB) from ${data.word || data.query}`);
      delete data.imageUrl;
    }
  }
  
  // Check phrase vocabs images
  if (cloned.type === 'phrase' && Array.isArray(data.vocabs)) {
    data.vocabs = data.vocabs.map((vocab: any) => {
      if (vocab.imageUrl && vocab.imageUrl.startsWith('data:image/')) {
        const imageSize = vocab.imageUrl.length * 0.75;
        if (imageSize > MAX_IMAGE_SIZE) {
          console.warn(`🔥 Firebase: Stripping oversized vocab image from ${vocab.word}`);
          const { imageUrl, ...rest } = vocab;  // Remove imageUrl from object
          return rest;
        }
      }
      return vocab;
    });
  }
  
  // Final size check
  const docSize = JSON.stringify(cloned).length;
  if (docSize > MAX_DOC_SIZE) {
    console.warn(`🔥 Firebase: Document still too large (${Math.round(docSize/1024)}KB), stripping all images`);
    delete data.imageUrl;
    if (Array.isArray(data.vocabs)) {
      data.vocabs = data.vocabs.map((vocab: any) => {
        const { imageUrl, ...rest } = vocab;
        return rest;
      });
    }
  }
  
  return cloned;
};

export const saveUserData = async (userId: string, items: StoredItem[]) => {
  if (!db || !userId) return;
  
  try {
    // Separate active and deleted items for logging, but we handle them similarly now (Soft Delete)
    const activeItems = items.filter(item => !item.isDeleted);
    const deletedItems = items.filter(item => item.isDeleted);
    
    // OPTIMIZATION: Limit batch size to avoid excessive writes
    // Firestore allows 500 ops/batch, but we limit to 100 for cost control
    const MAX_BATCH_SIZE = 100;
    
    if (activeItems.length === 0 && deletedItems.length === 0) {
        console.log("🔥 Firebase: No changes to sync");
        return;
    }

    // Update Parent Document (reduced frequency check)
    const userDocRef = doc(db, "users", userId);
    await setDoc(userDocRef, { 
        lastSynced: Date.now()
    }, { merge: true });

    // Combine all items to write (both active and deleted)
    // We use Soft Deletes (isDeleted: true) instead of actual deletion to ensure sync propagation
    const allItems = [...activeItems, ...deletedItems];
    const totalBatches = Math.ceil(allItems.length / MAX_BATCH_SIZE);
    let writeCountTotal = 0;

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * MAX_BATCH_SIZE;
      const batchItems = allItems.slice(start, start + MAX_BATCH_SIZE);
      
      console.log(`🔥 Firebase: Syncing batch ${batchIndex + 1}/${totalBatches} -> ${batchItems.length} items`);

      // Process items to fit within Firestore document size limits
      // Strip oversized images to stay under 1MB limit
      const processedItems: StoredItem[] = batchItems.map(item => prepareItemForFirestore(item));

      const batch = writeBatch(db);
      let batchWriteCount = 0;
      
      processedItems.forEach(item => {
          if (item.data && item.data.id) {
              const docRef = doc(db, "users", userId, "items", item.data.id);
              batch.set(docRef, item, { merge: true });
              batchWriteCount++;
          }
      });
      
      if (batchWriteCount > 0) {
          await batch.commit();
          console.log(`🔥 Firebase: ✅ Batch ${batchIndex + 1} committed (${batchWriteCount} writes)`);
          writeCountTotal += batchWriteCount;
      }
    }

    console.log(`🔥 Firebase: ✅ Sync complete! Total writes: ${writeCountTotal}`);
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

/**
 * Record a study session (for streak and activity tracking)
 * Only records when online - sessions are not queued for offline
 */
export const recordStudySession = async (
  userId: string,
  sessionData: {
    reviews: number;
    studyTime: number;
    accuracy: number;
  }
): Promise<void> => {
  // Skip if offline - session recording is not critical
  if (!navigator.onLine) {
    console.log("📴 Offline: Skipping session recording");
    return;
  }
  
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

