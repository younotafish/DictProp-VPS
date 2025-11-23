# Firebase Setup Guide for PopDict

## 🚀 Quick Start

Your app is already integrated with Firebase! Follow these steps to enable cross-device sync.

## 1. Firebase Console Setup

### Step 1: Enable Firestore Database

1. Go to [Firebase Console](https://console.firebase.google.com/project/dictpropstore)
2. Click **"Firestore Database"** in the left sidebar
3. Click **"Create database"**
4. Choose **"Start in production mode"**
5. Select a region (e.g., `us-central1` or closest to your users)

### Step 2: Set Security Rules

In the Firestore Database page, click on the **"Rules"** tab and paste:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only read/write their own data
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
      
      // Allow access to user's items subcollection
      match /items/{itemId} {
        allow read, write: if request.auth != null && request.auth.uid == userId;
      }
    }
  }
}
```

Click **"Publish"** to save the rules.

### Step 3: Enable Google Authentication

1. Click **"Authentication"** in the left sidebar
2. Click **"Get started"**
3. Go to the **"Sign-in method"** tab
4. Click on **"Google"**
5. Toggle it to **"Enabled"**
6. Add your support email
7. Click **"Save"**

### Step 4: Add Authorized Domains

In Authentication → Settings → Authorized domains, make sure these are added:
- `localhost` (for local development)
- Your production domain when you deploy (e.g., `myapp.com`)

## 2. How It Works

### Data Structure

```
Firestore Database:
users/
  └── {userId}/              ← Google Account ID (unique per user)
      ├── lastSynced         ← Timestamp of last sync
      ├── itemCount          ← Number of items
      └── items/             ← Subcollection of vocab/phrases
          ├── {itemId1}      ← Individual saved item
          │   ├── data       ← Vocab or phrase data
          │   ├── srs        ← Spaced repetition data
          │   ├── savedAt    ← When it was saved
          │   ├── updatedAt  ← Last update time
          │   └── isDeleted  ← Soft delete flag
          └── {itemId2}
              └── ...
```

### Sync Flow

1. **Sign In**: User signs in with Google account
2. **Real-time Listener**: App subscribes to cloud changes
3. **Merge**: Local and cloud data are intelligently merged
4. **Auto-save**: Changes are automatically synced to cloud (2s debounce)
5. **Cross-device**: Other devices receive updates in real-time

### Conflict Resolution

The app uses smart merging:
- **Learning progress wins**: Device with more study history is prioritized
- **Deletion respected**: Deleted items sync across devices
- **Timestamp fallback**: Most recent update wins if progress is equal

## 3. Testing the Setup

### Test 1: Single Device

1. Open the app at http://localhost:3001/
2. Click on **"Notebook"** tab
3. Click **"Sign in with Google"**
4. Search for a word and save it
5. Check Firebase Console → Firestore Database
   - You should see: `users → {your-user-id} → items → {item-id}`

### Test 2: Cross-Device Sync

1. Sign in on Device 1
2. Save a word/phrase
3. Open app on Device 2 (or another browser)
4. Sign in with the **same Google account**
5. The saved item should appear automatically! 🎉

### Test 3: Real-time Updates

1. Open app in two browser windows side-by-side
2. Sign in with same account in both
3. Save an item in Window 1
4. Watch it appear in Window 2 within 2 seconds

## 4. Troubleshooting

### "Permission Denied" Error

**Problem**: Firestore rules not set correctly

**Solution**: 
1. Go to Firestore Database → Rules
2. Make sure the rules match the ones above
3. Click "Publish"
4. Wait 30 seconds for rules to propagate

### "Auth Domain Not Authorized"

**Problem**: Your domain is not in the authorized list

**Solution**:
1. Go to Authentication → Settings → Authorized domains
2. Add `localhost` for development
3. Add your production domain when deploying

### Items Not Syncing

**Check**:
1. Are you signed in? (Check Notebook tab for your profile)
2. Open browser console (F12) - look for 🔥 Firebase logs
3. Check internet connection
4. Verify Firestore rules are published

## 5. Firestore Quotas (Free Tier)

Firebase Free plan includes:
- ✅ 1 GB storage
- ✅ 10 GB/month bandwidth  
- ✅ 50,000 reads/day
- ✅ 20,000 writes/day
- ✅ Unlimited real-time connections

This is **more than enough** for personal use and testing!

## 6. Production Deployment

When deploying to production:

1. Add your production domain to Firebase authorized domains
2. Consider upgrading to Blaze (pay-as-you-go) plan for production
3. Set up Firebase App Check for additional security
4. Monitor usage in Firebase Console → Usage dashboard

## 7. Alternative: Custom Server Sync

Your app also supports custom server sync! See `services/restSync.ts` for implementation details.

To use custom server instead of Firebase:
1. Click "Settings" in Notebook tab
2. Toggle to "Custom Server"
3. Enter your server URL and API key

---

## 🎉 You're All Set!

Your PopDict app now has:
- ✅ Per-user isolated data
- ✅ Real-time sync across devices
- ✅ Offline support (IndexedDB)
- ✅ Smart conflict resolution
- ✅ Google authentication

Sign in and start building your vocabulary! 📚

