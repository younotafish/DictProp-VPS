import React, { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmModal } from './ConfirmModal';
import { AlertTriangle, Loader2, LogOut, User as UserIcon } from 'lucide-react';
import type { AuthUser } from '../services/auth';
import { NEEDS_CONNECTION, networkRowDisabled } from '../services/connectivityNotice';
import { useRefusedReviews } from './RefusedReviews';

interface Props {
  /** The signed-in account. */
  user: AuthUser;
  /** Resolves false when the server couldn't be reached and the session was kept (services/auth logout). */
  onSignOut: () => Promise<boolean>;
  /** Opens the list of reviews the server refused, App's dialog. */
  onViewRefusedReviews: () => void;
  /** An outage has settled, so Sign out, which needs the server, is disabled with the reason. */
  offline: boolean;
}

// Avatar with offline fallback
const UserAvatar: React.FC<{ photoUrl: string | null; displayName: string | null }> = ({ photoUrl, displayName }) => {
  const [imgError, setImgError] = useState(false);

  // Show icon fallback if no photo URL or image failed to load
  if (!photoUrl || imgError) {
    return (
      <div className="w-6 h-6 rounded-full flex items-center justify-center bg-indigo-100 text-indigo-600">
        <UserIcon size={14} />
      </div>
    );
  }

  return (
    <img
      src={photoUrl}
      alt={displayName || 'Profile'}
      className="w-6 h-6 rounded-full bg-slate-100"
      onError={() => setImgError(true)}
    />
  );
};

export const UserMenu: React.FC<Props> = ({ user, onSignOut, onViewRefusedReviews, offline }) => {
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const refusedCount = useRefusedReviews(user.id).entries.length;
  const signOutUnavailable = networkRowDisabled('signout', !offline);
  const reasonId = useId();

  // Signing out needs the server, so offline it goes no further than the tap: nothing is sent, the session stays, and
  // the notice says why. Once an outage settles the button is disabled instead; this covers the seconds before.
  const requestSignOut = () => {
    if (navigator.onLine) setConfirmingSignOut(true);
    else setSignOutFailed(true);
  };

  const signOut = async () => {
    setConfirmingSignOut(false);
    if (!navigator.onLine) {
      setSignOutFailed(true);
      return;
    }
    setSigningOut(true);
    const signedOut = await onSignOut().catch(() => false);
    // Signing out reloads the page; if it didn't, the session was kept, so say why.
    if (!signedOut) {
      setSigningOut(false);
      setSignOutFailed(true);
    }
  };

  return (
    <div className="flex items-center gap-1 flex-nowrap shrink-0">
      <div className="flex items-center gap-1.5 pl-1 pr-2 py-0.5">
        <UserAvatar
          photoUrl={user.photoUrl}
          displayName={user.displayName}
        />
        <span className="text-xs font-medium text-slate-600 max-w-[60px] truncate hidden sm:inline">
            {user.displayName?.split(' ')[0] || 'User'}
        </span>
      </div>
      {refusedCount > 0 && (
        <button
          onClick={onViewRefusedReviews}
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
        onClick={requestSignOut}
        disabled={signingOut || signOutUnavailable}
        className="w-11 h-11 shrink-0 flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors disabled:opacity-50"
        title={signOutUnavailable ? NEEDS_CONNECTION : 'Sign Out'}
        aria-label="Sign out"
        aria-describedby={signOutUnavailable ? reasonId : undefined}
      >
        {signingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
      </button>
      {signOutUnavailable && <span id={reasonId} className="sr-only">{NEEDS_CONNECTION}</span>}
      {/* In a portal: the header this sits in slides away on scroll, and would carry a fixed dialog with it. */}
      {confirmingSignOut && createPortal(
        <ConfirmModal
          title="Sign out?"
          message="You'll need to be online to sign back in."
          confirmText="Sign Out"
          variant="danger"
          onConfirm={signOut}
          onCancel={() => setConfirmingSignOut(false)}
        />,
        document.body,
      )}
      {signOutFailed && createPortal(
        <ConfirmModal
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
