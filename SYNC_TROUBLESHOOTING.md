# 🔧 Sync Troubleshooting Guide

## Quick Diagnosis

### Step 1: Open Browser Console

1. Open your app at http://localhost:3001/
2. Press **F12** (or right-click → Inspect)
3. Go to **Console** tab
4. Look for messages with 🔥 emoji

### Step 2: Check What You Should See

#### When App Loads:
```
💾 Saved to IndexedDB: 0 items
```

#### When You Sign In:
```
🔥 Setting up Firebase sync for user: {user-id}
🔥 Firebase: Subscribing to updates for user: {user-id}
🔥 Firebase: Snapshot received, hasPendingWrites: false, fromCache: true
🔥 Firebase: Received 0 items from cloud (cache)
```

#### When You Save an Item:
```
💾 Saved to IndexedDB: 1 items
🔥 Syncing to Firebase... 1 items for user: {user-id}
🔥 Firebase: Saving 1 items to cloud...
🔥 Firebase: Write successful.
🔥 Firebase sync complete!
```

#### On Other Device (when sync happens):
```
🔥 Firebase: Snapshot received, hasPendingWrites: false, fromCache: false
🔥 Firebase: Received 1 items from cloud (server)
🔥 Received items from Firebase: 1
🔥 Merged items: 1 local: 0
```

---

## Common Issues & Solutions

### ❌ Issue 1: "Permission Denied" Error

**Symptoms:**
```
🔥 Firestore subscription error: FirebaseError: Permission denied
🔥 Firebase sync error: Error: Permission denied
```

**Cause:** Firestore database not set up or security rules incorrect

**Solution:**

1. Go to [Firebase Console](https://console.firebase.google.com/project/dictpropstore)
2. Click **Firestore Database** → **Create database**
3. Click **Rules** tab and paste:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      match /items/{itemId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

4. Click **Publish**
5. Refresh your app

---

### ❌ Issue 2: No Firebase Messages in Console

**Symptoms:**
- Only see `💾 Saved to IndexedDB` messages
- No 🔥 Firebase messages at all

**Cause:** Not signed in OR sync config is wrong

**Solution A: Check if signed in**
1. Go to **Notebook** tab
2. Look for your Google profile picture/name at top
3. If not signed in, click **"Sign in with Google"**

**Solution B: Reset sync config**
1. Open http://localhost:3001/debug_sync.html
2. Click **"Check localStorage Config"**
3. Verify it shows: `"type": "firebase"`
4. If not, click **"Reset to Firebase Sync"**
5. Refresh main app

---

### ❌ Issue 3: "Unauthorized Domain" Error

**Symptoms:**
```
Auth domain not authorized for this app
```

**Solution:**
1. Go to [Firebase Console](https://console.firebase.google.com/project/dictpropstore/authentication/settings)
2. Click **Authentication** → **Settings** → **Authorized domains**
3. Add `localhost`
4. Click **Add domain**
5. Try signing in again

---

### ❌ Issue 4: Items Save But Don't Sync

**Symptoms:**
```
💾 Saved to IndexedDB: 1 items
🔥 Syncing to Firebase... 1 items for user: {user-id}
🔥 Firebase: Write successful.
```
But other browser doesn't receive updates

**Possible Causes:**

**A. Other browser not signed in with same account**
- Verify both browsers show the same email address in Notebook tab

**B. Other browser has sync disabled**
1. Check console for: `🔥 Setting up Firebase sync`
2. If missing, refresh the page

**C. Network issue**
- Check internet connection
- Look for `fromCache: true` in console
- If always seeing cache, might be offline

**D. Browser cache issue**
- Hard refresh both browsers (Cmd/Ctrl + Shift + R)
- Or open in incognito mode

---

### ❌ Issue 5: Getting "hasPendingWrites: true" Loop

**Symptoms:**
```
🔥 Firebase: Ignoring local writes to prevent loop
```
(Repeating constantly)

**Solution:**
This is actually NORMAL after saving! It means the system is correctly preventing infinite loops. You should see this once after each save, then it stops.

If it repeats forever:
1. Sign out
2. Clear browser data (or use incognito)
3. Sign in again

---

## Manual Testing Steps

### Test 1: Single Device Sync

1. **Open app** → Sign in with Google
2. **Go to Search** → Search for "serendipity"  
3. **Save the word** (click bookmark icon)
4. **Check console** for:
   ```
   🔥 Firebase: Write successful
   ```
5. **Go to Firebase Console** → Firestore Database
6. You should see: `users → {your-uid} → items → {item-id}`

### Test 2: Two Browser Sync

1. **Browser A**: Sign in → Save word "ephemeral"
2. **Browser B**: Sign in with **same Google account**
3. **In Browser B console** look for:
   ```
   🔥 Firebase: Received 1 items from cloud (server)
   ```
4. **In Browser B**: Go to Notebook tab
5. You should see "ephemeral" appear!

### Test 3: Real-time Sync

1. **Open app in 2 windows side-by-side**
2. **Sign in both** with same account
3. **Window 1**: Save a word
4. **Window 2**: Watch console and Notebook tab
5. Should update within 2-3 seconds automatically!

---

## Debug Checklist

Use this checklist to diagnose issues:

- [ ] Firestore database is created in Firebase Console
- [ ] Security rules are set and published
- [ ] Google authentication is enabled
- [ ] `localhost` is in authorized domains
- [ ] Both browsers signed in with SAME Google account
- [ ] Console shows `🔥 Setting up Firebase sync` message
- [ ] Sync config type is "firebase" (check debug_sync.html)
- [ ] No "Permission denied" errors in console
- [ ] Internet connection is working
- [ ] Tried hard refresh (Cmd/Ctrl + Shift + R)

---

## Advanced: Check Firestore Data Directly

1. Go to [Firebase Console](https://console.firebase.google.com/project/dictpropstore/firestore)
2. Click **Firestore Database**
3. You should see a `users` collection
4. Click to expand → find your user ID
5. Click `items` subcollection
6. You should see your saved words/phrases here

If you DON'T see data here but console shows "Write successful":
- There might be a security rule blocking writes
- Try the rules from Issue 1 above

---

## Still Not Working?

If none of the above helps, collect this info:

1. **Console logs** (copy all 🔥 messages)
2. **Sync config** (from debug_sync.html)
3. **Firebase Rules** (from Firestore → Rules tab)
4. **Error messages** (any red errors in console)

Share these and we can debug further!

---

## Quick Fixes Summary

| Problem | Quick Fix |
|---------|-----------|
| Permission denied | Set up Firestore rules |
| No Firebase logs | Check if signed in |
| Unauthorized domain | Add localhost to Firebase |
| Items don't sync | Verify same account both browsers |
| Blank screen | Hard refresh (Cmd+Shift+R) |

---

**Pro Tip:** Use the debug tool at http://localhost:3001/debug_sync.html to quickly check your configuration!

