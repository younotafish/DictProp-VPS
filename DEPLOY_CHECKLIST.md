# 🚀 Firebase Deployment Checklist

Use this checklist every time you deploy to ensure authentication works on all platforms.

---

## ✅ Pre-Deployment

- [ ] **Build the app**
  ```bash
  npm run build
  ```

- [ ] **Verify Firebase version fix**
  - Check `dist/index.html` has unified Firebase imports (v12.6.0)
  - Should NOT have mixed versions (10.7.1 vs 12.6.0)

---

## ✅ Deployment

- [ ] **Deploy to Firebase Hosting**
  ```bash
  npm run deploy
  ```

- [ ] **Note your deployment URL** (shown after deploy completes)
  - Usually: `https://dictpropstore.web.app`
  - Or: `https://dictpropstore.firebaseapp.com`

---

## ✅ Firebase Console Configuration

- [ ] **Open Firebase Console**
  - URL: https://console.firebase.google.com/
  - Project: `dictpropstore`

- [ ] **Add Authorized Domains**
  1. Go to: **Authentication** → **Settings** → **Authorized domains**
  2. Click **"Add domain"**
  3. Add: `dictpropstore.web.app`
  4. Click **"Add domain"** again
  5. Add: `dictpropstore.firebaseapp.com`
  6. Verify `localhost` is already there (for local dev)

- [ ] **Enable Google Sign-In Provider** (if not already)
  1. Go to: **Authentication** → **Sign-in method**
  2. Click on **Google**
  3. Enable if disabled
  4. Save

---

## ✅ Testing

### Test on Desktop (Chrome/Safari)
- [ ] Open: `https://dictpropstore.web.app`
- [ ] Click "Sign in with Google"
- [ ] Popup opens → Complete sign-in
- [ ] User is authenticated ✅

### Test on iOS Safari
- [ ] Open Safari on iPhone/iPad
- [ ] Navigate to: `https://dictpropstore.web.app`
- [ ] Click "Sign in with Google"
- [ ] Redirects to Google → Authenticate
- [ ] Redirects back to app
- [ ] User is authenticated ✅

### Test on iOS Chrome
- [ ] Open Chrome on iPhone/iPad
- [ ] Navigate to: `https://dictpropstore.web.app`
- [ ] Click "Sign in with Google"
- [ ] Redirects to Google → Authenticate
- [ ] Redirects back to app
- [ ] User is authenticated ✅

---

## 🐛 Troubleshooting

### If sign-in fails on iOS:

1. **Check error in app** (should show error modal)
   - If shows "Unauthorized domain" → Domain not added to Firebase Console
   - Fix: Add domain as described above

2. **Clear iOS cache**
   ```
   Settings → Safari → Clear History and Website Data
   ```

3. **Disable tracking prevention** (temporarily)
   ```
   Settings → Safari → Disable "Prevent Cross-Site Tracking"
   ```

4. **Check Web Inspector** (on Mac)
   - Settings → Safari → Advanced → Enable Web Inspector
   - Connect iPhone to Mac via USB
   - Safari (Mac) → Develop → [iPhone] → [Your site]
   - Check Console for errors

5. **Wait for DNS propagation** (~1-2 minutes after adding domain)

### If sign-in works on desktop but not mobile:
- ✅ This is the EXACT problem we fixed!
- Follow the "Add Authorized Domains" steps above
- The issue is 99% of the time missing authorized domains

---

## 📝 Common Mistakes

❌ **Forgot to add `.web.app` domain to Firebase Console**
✅ Add both `.web.app` AND `.firebaseapp.com`

❌ **Testing immediately after adding domain**
✅ Wait 1-2 minutes for propagation

❌ **Using old cached version**
✅ Hard refresh or clear cache

❌ **Third-party cookies blocked on iOS**
✅ Temporarily disable "Prevent Cross-Site Tracking" in iOS Safari settings

---

## 🎉 Success Indicators

When everything is working:
- ✅ Desktop Chrome: Popup authentication works
- ✅ iOS Safari: Redirect authentication works
- ✅ iOS Chrome: Redirect authentication works
- ✅ User stays signed in after closing/reopening app
- ✅ Data syncs across devices
- ✅ No console errors

---

## 🔗 Helpful Links

- **Firebase Console**: https://console.firebase.google.com/
- **Detailed iOS Fix**: [IOS_AUTH_FIX.md](./IOS_AUTH_FIX.md)
- **Firebase Auth Docs**: https://firebase.google.com/docs/auth/web/redirect-best-practices
- **Your Deployed App**: https://dictpropstore.web.app

---

**Last Updated**: 2025-11-23

