
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
  collection,
  onSnapshot,
  writeBatch,
  Firestore
} from "firebase/firestore";
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
  
  console.log("🔥 Firebase: Subscribing to updates...");

  return onSnapshot(itemsCollection, (snapshot) => {
    // IGNORE LOCAL WRITES to prevent loops
    if (snapshot.metadata.hasPendingWrites) return;

    const items: StoredItem[] = [];
    snapshot.forEach(doc => {
        items.push(doc.data() as StoredItem);
    });
    
    if (items.length > 0) {
        console.log(`🔥 Firebase: Received ${items.length} items from cloud.`);
    }
    onData(items);
  }, (error) => {
      console.error("Firestore subscription error:", error);
  });
};

export const saveUserData = async (userId: string, items: StoredItem[]) => {
  if (!db || !userId) return;
  
  try {
    // Force Create Parent Document to ensure it shows in Console
    const userDocRef = doc(db, "users", userId);
    await setDoc(userDocRef, { 
        lastSynced: Date.now(),
        itemCount: items.length 
    }, { merge: true });

    const batch = writeBatch(db);
    let opCount = 0;
    
    console.log(`🔥 Firebase: Saving ${items.length} items to cloud...`);

    items.slice(0, 490).forEach(item => {
        if (item.data && item.data.id) {
            const docRef = doc(db, "users", userId, "items", item.data.id);
            if (item.isDeleted) {
                // If it's deleted locally, we explicitly mark it deleted in cloud (Soft Delete)
                batch.set(docRef, item);
            } else {
                batch.set(docRef, item);
            }
            opCount++;
        }
    });

    if (opCount > 0) {
        await batch.commit();
        console.log("🔥 Firebase: Write successful.");
    }
  } catch (e: any) {
    console.error("Error saving to cloud", e);
    if (e.code === 'permission-denied') {
        console.error("Check Firestore Rules! Read/Write must be allowed.");
        throw new Error("Permission denied. Check database rules.");
    }
  }
};
