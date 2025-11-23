# 🎨 Image Sync Setup - Firebase Storage

## ✅ What's New

Images now sync across devices using **Firebase Cloud Storage**!

### Before (Base64 - Local Only):
```javascript
{
  data: {
    word: "ephemeral",
    imageUrl: "data:image/png;base64,iVBORw0KG..." // ❌ 500KB, local only
  }
}
```

### After (Storage URL - Synced):
```javascript
{
  data: {
    word: "ephemeral",
    imageUrl: "https://firebasestorage.googleapis.com/..." // ✅ Tiny URL, syncs!
  }
}
```

---

## 🔧 Firebase Storage Setup (One-Time)

### Step 1: Enable Firebase Storage

1. Go to [Firebase Console](https://console.firebase.google.com/project/dictpropstore/storage)
2. Click **"Get started"**
3. Click **"Next"** (use production mode)
4. Select your region (same as Firestore)
5. Click **"Done"**

### Step 2: Set Storage Rules

1. Click on the **"Rules"** tab
2. Delete everything and paste:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Allow users to read/write their own images
    match /users/{userId}/{allPaths=**} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

3. Click **"Publish"**

**That's it!** Images will now sync across devices automatically.

---

## 📊 How It Works

### Upload Flow (When Saving)

```
Device 1:
1. Generate image with Gemini → Base64 string
2. Save item → Triggers sync
3. Upload base64 to Storage → Get download URL
4. Save URL to Firestore → "https://firebasestorage..."
   
Cloud:
Storage: image.png (actual file)
Firestore: { imageUrl: "https://..." }

Device 2:
1. Receives Firestore update → URL
2. Browser loads image from URL automatically
3. Image appears! 🎉
```

### Storage Structure

```
users/
  └── {userId}/
      └── items/
          ├── {itemId}_main_1234567890.png        ← Main image
          ├── {itemId}_vocab0_1234567891.png      ← Vocab 1 image
          └── {itemId}_vocab1_1234567892.png      ← Vocab 2 image
```

---

## 🧪 Testing Image Sync

### Test 1: Single Image

1. **Browser 1**: Sign in
2. Search for "ephemeral"
3. Wait for image generation
4. Click **Save**
5. Watch console:
   ```
   🔥 Storage: Uploaded image to users/{uid}/items/{id}_main_123.png
   🔥 Firebase: ✅ Sync complete! Images uploaded to Storage.
   ```

6. **Firebase Console** → Storage:
   - You should see the image file in `users/{your-id}/items/`

### Test 2: Cross-Device Sync

1. **Browser 1**: Save item with image (as above)
2. **Browser 2**: Sign in with **same account**
3. Go to **Notebook**
4. Click on the synced item
5. **Image appears!** 🎉

### Test 3: Phrases with Multiple Vocab Images

1. **Browser 1**: Search for a long phrase
2. Let it generate (phrase image + vocab images)
3. Save it
4. **Browser 2**: Receive and view
5. **All images sync!**

---

## 💰 Firebase Storage Free Tier

- ✅ **5 GB** storage
- ✅ **1 GB/day** download bandwidth
- ✅ **50,000** uploads/day
- ✅ **50,000** downloads/day

**For typical use:**
- Average image: ~50 KB
- 5 GB = ~100,000 images
- **More than enough!**

---

## 🔍 Troubleshooting

### Images Not Appearing on Second Device

**Check Console:**

```
✅ Good:
🔥 Storage: Uploaded image to users/.../items/...
🔥 Firebase: ✅ Sync complete! Images uploaded to Storage.

❌ Bad:
🔥 Storage: Upload failed: [error]
```

**Solutions:**

1. **"Permission denied"** on upload:
   - Go to Storage → Rules
   - Make sure rules match the ones above
   - Click "Publish"

2. **Images show on Device 1 but not Device 2:**
   - Check if URL starts with `https://firebasestorage`
   - If it's still `data:image/`, the upload failed
   - Try saving the item again

3. **"CORS error" in browser:**
   - This is normal! Firebase Storage handles CORS
   - Images will still load (might see warning in console)

---

## 🎯 Image Types Supported

### ✅ Synced Across Devices:
- Vocab card images
- Phrase images  
- Vocab images within phrases

### How Images Are Detected:
- Base64 images (starting with `data:image/`) → Uploaded to Storage
- Storage URLs (starting with `https://firebasestorage`) → Already synced, kept as-is
- External URLs → Kept as-is (not uploaded)

---

## 📋 Technical Details

### Upload Process

1. **Detection**: Check if `imageUrl` starts with `data:image/`
2. **Path**: Create unique path: `users/{uid}/items/{itemId}_main_{timestamp}.png`
3. **Upload**: Use `uploadString(ref, base64, 'data_url')`
4. **URL**: Get download URL: `getDownloadURL(ref)`
5. **Replace**: Replace base64 with Storage URL in item data
6. **Save**: Save updated item to Firestore

### Benefits Over Base64

| Aspect | Base64 (Old) | Storage URL (New) |
|--------|--------------|-------------------|
| Size in Firestore | 500KB+ | ~100 bytes |
| Sync across devices | ❌ No | ✅ Yes |
| Bandwidth usage | High | Low (cached) |
| Firestore doc limit | Easily exceeded | Never a problem |
| Browser caching | ❌ No | ✅ Yes |
| Searchable in Storage | ❌ No | ✅ Yes |

---

## 🚀 Migration from Local Images

**Existing items with base64 images:**

When you save an existing item:
1. Base64 image is detected
2. Uploaded to Storage
3. URL replaces base64
4. Item is re-saved with URL
5. **Now syncs across devices!**

**No manual migration needed** - happens automatically when items are saved.

---

## 🎉 You're All Set!

Once Storage is enabled:
- ✅ All new images auto-upload to Storage
- ✅ Images sync across all devices
- ✅ Existing images convert on next save
- ✅ Firestore stays under size limits

**Just enable Storage in Firebase Console and images will sync!** 🚀

