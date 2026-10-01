import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { AlertTriangle, Loader2, LogOut, User as UserIcon } from 'lucide-react';
import { AppUser } from '../types';
import { useRefusedReviews } from './RefusedReviews';
import { RefusedReviewsDialog } from './RefusedReviewsDialog';

interface Props {
  user: AppUser | null;
  onSignIn: () => void;
  /** Resolves false when the server couldn't be reached and the session was kept (services/auth logout). */
  onSignOut: () => void | Promise<boolean | void>;
}

// Inline Google "G" SVG to work offline
const GoogleIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
  </svg>
);

// Avatar with offline fallback
const UserAvatar: React.FC<{ photoURL?: string | null; displayName?: string | null }> = ({ photoURL, displayName }) => {
  const [imgError, setImgError] = useState(false);
  
  // Show icon fallback if no photo URL or image failed to load
  if (!photoURL || imgError) {
    return (
      <div className="w-6 h-6 rounded-full flex items-center justify-center bg-indigo-100 text-indigo-600">
        <UserIcon size={14} />
      </div>
    );
  }
  
  return (
    <img 
      src={photoURL} 
      alt={displayName || 'Profile'} 
      className="w-6 h-6 rounded-full bg-slate-100" 
      onError={() => setImgError(true)}
    />
  );
};

export const UserMenu: React.FC<Props> = ({ user, onSignIn, onSignOut }) => {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const refusedCount = useRefusedReviews(user?.uid).entries.length;
  const [showingRefused, setShowingRefused] = useState(false);

  const signOut = async () => {
    setConfirmingSignOut(false);
    setSigningOut(true);
    let signedOut: boolean | void = false;
    try { signedOut = await onSignOut(); } catch { /* treated as not signed out */ }
    // Signing out reloads the page; if it didn't, the session was kept, so say why.
    if (signedOut !== true) setSigningOut(false);
    if (signedOut === false) setSignOutFailed(true);
  };

  if (!user) {
    return (
      <div className="flex items-center gap-1 flex-nowrap shrink-0">
        <Button variant="primary" size="sm" onClick={onSignIn} aria-label="Sign in with Google" className="flex items-center gap-1.5 text-xs bg-white text-slate-700 border-0 hover:bg-slate-50 px-2 py-1 whitespace-nowrap">
            <GoogleIcon />
            <span className="hidden sm:inline">Sign In</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-nowrap shrink-0">
      <div className="flex items-center gap-1.5 pl-1 pr-2 py-0.5">
        <UserAvatar 
          photoURL={user.photoURL} 
          displayName={user.displayName}
        />
        <span className="text-xs font-medium text-slate-600 max-w-[60px] truncate hidden sm:inline">
            {user.displayName?.split(' ')[0] || 'User'}
        </span>
      </div>
      {refusedCount > 0 && (
        <button
          onClick={() => setShowingRefused(true)}
          className="relative w-11 h-11 shrink-0 flex items-center justify-center text-amber-500 hover:text-amber-700 hover:bg-amber-50 rounded-full transition-colors"
          title="Reviews the server refused"
          aria-label={`Reviews the server refused: ${refusedCount}`}
        >
          <AlertTriangle size={14} />
          <span className="absolute top-1.5 right-1 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-4 text-center">
            {refusedCount}
          </span>
        </button>
      )}
      <button 
        onClick={() => setConfirmingSignOut(true)}
        disabled={signingOut}
        className="w-11 h-11 shrink-0 flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors disabled:opacity-50"
        title="Sign Out"
        aria-label="Sign out"
      >
        {signingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
      </button>
      {/* In a portal: the header this sits in slides away on scroll, and would carry a fixed dialog with it. */}
      {confirmingSignOut && createPortal(
        <ConfirmModal
          isOpen
          title="Sign out?"
          message="You'll need to be online to sign back in."
          confirmText="Sign Out"
          variant="danger"
          onConfirm={signOut}
          onCancel={() => setConfirmingSignOut(false)}
        />,
        document.body,
      )}
      {showingRefused && createPortal(
        <RefusedReviewsDialog userId={user.uid} onClose={() => setShowingRefused(false)} />,
        document.body,
      )}
      {signOutFailed && createPortal(
        <ConfirmModal
          isOpen
          title="Couldn't sign out"
          message="The server couldn't be reached, so you're still signed in. Try again once you're online."
          confirmText="OK"
          variant="warning"
          showCancel={false}
          onConfirm={() => setSignOutFailed(false)}
          onCancel={() => setSignOutFailed(false)}
        />,
        document.body,
      )}
    </div>
  );
};
