# User Data Isolation Fix

## Issue
Previously, the application used a shared local storage key (`user_items`) for all users. This caused a data leakage issue where:
1. User A logs in, syncs data, and stores it locally.
2. User A logs out (local data remains).
3. User B logs in.
4. The app loads the existing local data (User A's data) and merges it with User B's remote data.
5. Result: User B sees User A's items, and worse, pushes them to User B's Firestore account.

## Fix Implemented
We have implemented strict user isolation for local storage.

### 1. Storage Service (`services/storage.ts`)
- **Dynamic Storage Keys**: `loadData` and `saveData` now accept a `userId` parameter.
- **Key Format**: 
  - Guest (Unauthenticated): `items_guest`
  - Authenticated User: `items_{userId}`
- **Migration**: 
  - Legacy data found in `user_items` is automatically treated as `guest` data during migration.
  - This ensures no data loss for existing users while enforcing isolation for new sessions.

### 2. App Logic (`App.tsx`)
- **Initialization**: App starts by loading `guest` data.
- **Login Transition**:
  - When a user logs in, we **ignore** the current guest state (to prevent accidental merges of stale data).
  - We load the specific local storage for that user (`items_{userId}`).
  - We fetch remote data from Firestore.
  - We merge User Local + User Remote.
  - The UI updates to show ONLY the authenticated user's data.
- **Logout Transition**:
  - When a user logs out, we clear the state.
  - We load the `guest` data from storage.
  - This ensures User A's data is instantly removed from the view.

### 3. Security
- Local data is now partitioned by User ID.
- Access to one user's local cache does not grant access to another's (unless the attacker has physical access to the device and IndexedDB, which is outside app scope).
- Prevents cross-account data pollution.

## Testing
- **Scenario 1 (Logout/Login)**: Log in as User A -> Log out -> Log in as User B. User B should start with a clean slate (or their own data), not User A's data.
- **Scenario 2 (Offline)**: User A logs in, goes offline, adds items. Closes app. Opens app (offline). Data should load.
- **Scenario 3 (Guest)**: User uses app without login. Data saves to `items_guest`. User logs in. Guest data is NOT merged automatically (safety choice). User sees their account data. Log out. User sees guest data again.

