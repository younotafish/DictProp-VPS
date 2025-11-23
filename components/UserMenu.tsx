
import React from 'react';
import { Button } from './Button';
import { LogOut, User as UserIcon, Ghost } from 'lucide-react';

interface Props {
  user: any | null; // Firebase User
  onSignIn: () => void;
  onGuestSignIn?: () => void;
  onSignOut: () => void;
  isConfigured: boolean;
}

export const UserMenu: React.FC<Props> = ({ user, onSignIn, onGuestSignIn, onSignOut, isConfigured }) => {

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onGuestSignIn} className="flex items-center gap-2 text-xs" title="Guest Mode">
            <Ghost size={14} />
            Guest
        </Button>
        <Button variant="primary" size="sm" onClick={onSignIn} className="flex items-center gap-2 text-xs bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 shadow-sm">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-4 h-4" alt="G" />
            Sign In
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 bg-white rounded-full pl-1 pr-3 py-1 border border-slate-200 shadow-sm">
        {user.photoURL ? (
            <img src={user.photoURL} alt="Profile" className="w-6 h-6 rounded-full" />
        ) : (
            <div className={`w-6 h-6 rounded-full flex items-center justify-center ${user.isAnonymous ? 'bg-slate-100 text-slate-500' : 'bg-indigo-100 text-indigo-600'}`}>
                {user.isAnonymous ? <Ghost size={14} /> : <UserIcon size={14} />}
            </div>
        )}
        <span className="text-xs font-medium text-slate-600 max-w-[80px] truncate">
            {user.isAnonymous ? 'Guest' : (user.displayName || 'User')}
        </span>
      </div>
      <button 
        onClick={onSignOut}
        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        title="Sign Out"
      >
        <LogOut size={18} />
      </button>
    </div>
  );
};
