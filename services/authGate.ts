// The sign-in screen's words. Only that screen reads them, and it loads on demand, so they stay out of the app's first
// chunk; the rule for when a session has expired is services/auth.ts's nextAuthGate.

/** What the sign-in screen says above its button, or null, and the button's text and state. */
export interface SignInPrompt {
  message: string | null;
  button: string;
  disabled: boolean;
}

/**
 * After an expiry the screen says the library and its unsynced changes are safe on this device; offline, the button
 * waits for a connection, since signing in goes through Google.
 */
export const signInPrompt = ({ expired, online }: { expired: boolean; online: boolean }): SignInPrompt => ({
  message: expired
    ? 'Your sign-in expired. Your library and any changes not yet synced are kept on this device. Sign in to pick up where you left off.'
    : null,
  button: online ? 'Sign in with Google' : 'Connect to sign in',
  disabled: !online,
});
