import React from 'react';

// The screens App shows in place of the library: while sign-in is checked, to someone signed out, to an
// account awaiting approval, and when this device's copy of the library can't be read.

export const AuthLoadingScreen: React.FC = () => (
  <div className="fixed inset-0 bg-white flex items-center justify-center">
    <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
  </div>
);

export const SignInScreen: React.FC<{ onSignIn: () => void }> = ({ onSignIn }) => (
  <div className="fixed inset-0 bg-gradient-to-br from-indigo-50 to-white flex items-center justify-center">
    <div className="text-center space-y-6 p-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-slate-800">DictProp</h1>
        <p className="text-slate-500">AI-powered vocabulary learning</p>
      </div>
      <button
        onClick={onSignIn}
        className="inline-flex items-center gap-3 px-6 py-3 bg-white border border-slate-200 rounded-lg shadow-sm hover:shadow-md hover:bg-slate-50 transition-all text-slate-700 font-medium"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      </button>
    </div>
  </div>
);

export const PendingApprovalScreen: React.FC<{ onSignOut: () => void; signOutFailed: boolean }> = ({ onSignOut, signOutFailed }) => (
  <div className="fixed inset-0 bg-gradient-to-br from-amber-50 to-white flex items-center justify-center">
    <div className="text-center space-y-4 p-8">
      <div className="w-12 h-12 mx-auto bg-amber-100 rounded-full flex items-center justify-center">
        <span className="text-2xl">⏳</span>
      </div>
      <h2 className="text-xl font-semibold text-slate-800">Pending Approval</h2>
      <p className="text-slate-500 max-w-sm">Your account is awaiting admin approval. Please check back later.</p>
      <button onClick={onSignOut} className="text-sm text-slate-400 hover:text-slate-600 underline">Sign out</button>
      {signOutFailed && (
        <p role="alert" className="text-sm text-rose-600">Couldn{'\u2019'}t reach the server, so you{'\u2019'}re still signed in.</p>
      )}
    </div>
  </div>
);

export const LibraryReadFailedScreen: React.FC<{
  onRetry: () => void;
  onReload: () => void;
  onUseServerCopy: () => void;
}> = ({ onRetry, onReload, onUseServerCopy }) => (
  <div className="fixed inset-0 bg-slate-50 flex items-center justify-center p-6">
    <div role="alert" className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-sm w-full text-center">
      <h2 className="text-xl font-bold text-slate-800 mb-2">Couldn&rsquo;t open your library</h2>
      <p className="text-sm text-slate-500 mb-6 leading-relaxed">
        This device&rsquo;s copy couldn&rsquo;t be read. Trying again usually works. Using the server copy
        instead may lose changes made on this device that haven&rsquo;t synced yet.
      </p>
      <div className="flex flex-col gap-3">
        <button
          onClick={onRetry}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition-colors"
        >
          Try again
        </button>
        <button
          onClick={onReload}
          className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium rounded-xl transition-colors"
        >
          Reload app
        </button>
        <button
          onClick={onUseServerCopy}
          className="w-full py-2 text-sm text-slate-500 hover:text-slate-700 underline"
        >
          Use the server copy
        </button>
      </div>
    </div>
  </div>
);
