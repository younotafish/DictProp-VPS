<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# DictProp - Advanced AI Vocabulary Learning App

An intelligent vocabulary learning application powered by AI and advanced spaced repetition algorithms.

View your app in AI Studio: https://ai.studio/apps/drive/1xgIRAWPloe5gPdslYRnvsePJGf8tCfYT

## ✨ Key Features

- 🤖 **AI-Powered Definitions** - Get comprehensive word explanations using Gemini AI
- 🧠 **Advanced SRS System** - SuperMemo/Shanbay-inspired memory strength algorithm
- 🎯 **Multi-Task Learning** - Recognition, Recall, Typing, Listening, and Sentence tasks
- 📊 **Learning Analytics** - Track your progress with detailed insights
- ☁️ **Firebase Sync** - Cloud backup across devices
- 📱 **Mobile-First Design** - Beautiful, responsive UI optimized for mobile

## 🚀 Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key

3. Run the app:
   ```bash
   npm run dev
   ```

## ☁️ Deploy to Firebase Hosting

The repo ships with `firebase.json` + `.firebaserc` targeting the `dictpropstore` Firebase project and serving the built Vite output from `dist/` with SPA rewrites.

1. Install the CLI & authenticate (one-time):
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

2. **IMPORTANT**: Authorize your domain in Firebase Console (required for authentication):
   - Go to [Firebase Console](https://console.firebase.google.com/)
   - Select your project (`dictpropstore`)
   - Navigate to **Authentication** → **Settings** → **Authorized domains**
   - Click "Add domain" and add:
     - `dictpropstore.web.app` (default Firebase hosting)
     - `dictpropstore.firebaseapp.com` (Firebase hosting)
     - Any custom domains you're using
   - **Note:** This is especially critical for iOS/mobile browsers!
   - See [IOS_AUTH_FIX.md](./IOS_AUTH_FIX.md) for detailed troubleshooting
   
3. Build the static bundle:
   ```bash
   npm run build
   ```

4. Deploy to Firebase Hosting:
   ```bash
   npm run deploy
   ```

You can override the project by editing `.firebaserc` or passing `--project <id>` to the deploy script if you need to target a different Firebase environment.

## 📚 Advanced SRS System

The app features a sophisticated spaced repetition system with:

- **Memory Strength Model** (0-100 hidden metric)
- **Dynamic Review Intervals** based on forgetting curves
- **Task Difficulty Weighting** (harder tasks = stronger memory)
- **Automatic Time Decay** simulation
- **Firebase-Synced Learning History**

See [ADVANCED_SRS_GUIDE.md](./ADVANCED_SRS_GUIDE.md) for complete documentation.

## 🔄 Simple & Reliable Cloud Sync

The app features a **simple, optimized sync system** that just works:

### ✨ Key Features
- **Automatic Sync** - All data syncs to Firebase automatically
- **Real-Time Updates** - Changes appear on other devices within seconds
- **Smart Merging** - Preserves learning progress and recent edits
- **Offline Support** - Everything works offline, syncs when reconnected
- **Image Optimization** - Images stay local to avoid Firebase size limits

### 🧪 Testing
- Open `/check_items.html` to view what's in your Firebase
- See [SYNC_FIX_SUMMARY.md](./SYNC_FIX_SUMMARY.md) for technical details

## 🎓 Study Modes

1. **Recognition** ⭐ - Multiple choice (easiest)
2. **Recall** ⭐⭐ - Self-graded memory recall
3. **Listening** ⭐⭐⭐ - Audio-only recognition
4. **Typing** ⭐⭐⭐⭐ - Produce the word from meaning
5. **Sentence** ⭐⭐⭐⭐⭐ - Use in context (hardest)

The system automatically recommends task types based on your mastery level.

## 🔧 Setup Guides

- [Firebase Setup](./FIREBASE_SETUP.md) - Configure cloud sync
- [Image Sync Setup](./IMAGE_SYNC_SETUP.md) - Enable image storage
- [Cost Optimization](./FIREBASE_COST_OPTIMIZATION.md) - Reduce Firebase costs

## 📈 Learning Analytics

Track your progress with:
- Memory strength distribution
- Study streaks and consistency
- Performance by task type
- Strongest/weakest words
- Daily activity heatmaps

## 🔄 Automatic Migration

Existing data from the old SRS system will be **automatically migrated** on first load:
- Old intervals → converted to stability metrics
- Historical performance → used to estimate memory strength
- All progress preserved and enhanced

## 🔄 Cross-Device Sync

Your vocabulary data syncs seamlessly across all your devices:

### How It Works
1. **Initial Sync**: Sign in on any device → all your saved words load automatically
2. **Real-Time Updates**: Save a word → appears on other devices within 5-7 seconds
3. **Smart Merging**: Preserves your learning progress and most recent edits
4. **Offline First**: Everything works offline, syncs when you're back online

### Testing Sync
To verify sync is working:
1. Open the app on two devices (or two browser windows)
2. Sign in with the same Google account on both
3. Save a word on Device A
4. Watch it appear on Device B within a few seconds
5. Check console (F12) for "✅ Items synced to Firebase!"

## 🛠️ Tech Stack

- **React + TypeScript**
- **Vite** for fast development
- **Firebase** (Auth, Firestore, Storage)
- **Google Gemini AI** for definitions
- **Tailwind CSS** for styling
- **IndexedDB** for local storage

## 📝 License

MIT License - feel free to use and modify!
