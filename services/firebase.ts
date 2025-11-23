
import { initializeApp, FirebaseApp } from "firebase/app";
import { 
  getAuth, 
  signInWithPopup, 
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

export const signIn = async () => {
  if (!auth) throw new Error("NOT_CONFIGURED");
  try {
    await signInWithPopup(auth, provider);
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

  return onSnapshot(itemsCollection, (snapshot) => {
    // Log metadata for debugging
    console.log("🔥 Firebase: Snapshot received, fromCache:", snapshot.metadata.fromCache, "size:", snapshot.size);

    const items: StoredItem[] = [];
    snapshot.forEach(doc => {
        const data = doc.data() as StoredItem;
        // Only include non-deleted items (deleted items shouldn't be in Firestore anyway)
        if (!data.isDeleted) {
          items.push(data);
        }
    });
    
    console.log(`🔥 Firebase: Parsed ${items.length} active items from cloud (${snapshot.metadata.fromCache ? 'cache' : 'server'})`);
    
    // Always call onData - merge logic will handle conflicts
    onData(items);
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

// Helper: Process item images and upload to Storage
const processItemImages = async (userId: string, item: StoredItem): Promise<StoredItem> => {
  const processedItem = JSON.parse(JSON.stringify(item));
  
  if (!processedItem.data) return processedItem;
  
  // Process main image (for vocab cards or phrases)
  if (processedItem.data.imageUrl && processedItem.data.imageUrl.startsWith('data:image/')) {
    const downloadURL = await uploadImageToStorage(userId, processedItem.data.id, processedItem.data.imageUrl, 'main');
    if (downloadURL) {
      processedItem.data.imageUrl = downloadURL;
    }
  }
  
  // Process vocab images (for phrases)
  if (processedItem.type === 'phrase' && Array.isArray(processedItem.data.vocabs)) {
    for (let i = 0; i < processedItem.data.vocabs.length; i++) {
      const vocab = processedItem.data.vocabs[i];
      if (vocab.imageUrl && vocab.imageUrl.startsWith('data:image/')) {
        const downloadURL = await uploadImageToStorage(userId, processedItem.data.id, vocab.imageUrl, 'vocab', i);
        if (downloadURL) {
          processedItem.data.vocabs[i].imageUrl = downloadURL;
        }
      }
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
    
    // Force Create Parent Document
    const userDocRef = doc(db, "users", userId);
    await setDoc(userDocRef, { 
        lastSynced: Date.now(),
        itemCount: activeItems.length 
    }, { merge: true });

    console.log(`🔥 Firebase: Syncing ${activeItems.length} active items (${deletedItems.length} to delete)...`);

    // Process images: upload base64 to Storage and replace with URLs
    const processedItems: StoredItem[] = [];
    for (const item of activeItems.slice(0, 400)) {
      if (item.data && item.data.id) {
        const processedItem = await processItemImages(userId, item);
        processedItems.push(processedItem);
      }
    }

    const batch = writeBatch(db);
    let writeCount = 0;
    let deleteCount = 0;
    
    // Add/Update active items (now with Storage URLs instead of base64)
    processedItems.forEach(item => {
        if (item.data && item.data.id) {
            const docRef = doc(db, "users", userId, "items", item.data.id);
            batch.set(docRef, item);
            writeCount++;
        }
    });
    
    // Delete removed items from Firestore
    deletedItems.slice(0, 90).forEach(item => {
        if (item.data && item.data.id) {
            const docRef = doc(db, "users", userId, "items", item.data.id);
            batch.delete(docRef);
            deleteCount++;
        }
    });

    if (writeCount > 0 || deleteCount > 0) {
        console.log(`🔥 Firebase: Committing ${writeCount} writes, ${deleteCount} deletes...`);
        await batch.commit();
        console.log("🔥 Firebase: ✅ Sync complete! Images uploaded to Storage.");
    } else {
        console.log("🔥 Firebase: No changes to sync");
    }
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
