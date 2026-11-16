import type { Context } from 'hono';

// How the OAuth callback (routes/auth.ts) answers a sign-in it can't finish. The callback is a full-page navigation back
// from Google, so a browser gets a short page saying why, with a link back to the app; any other caller gets the JSON
// error the rest of the API sends.

interface SignInFailure {
  status: 400 | 403 | 502 | 503;
  /** The JSON reply's error. */
  error: string;
  /** What the page tells the visitor. */
  page: string;
}

export const SIGN_IN_FAILURES = {
  // No code, or no state cookie matching it: the cookie lasts 5 minutes, a finished callback clears it, and a newer
  // sign-in replaces it.
  invalidState: {
    status: 400,
    error: 'Invalid OAuth state',
    page: 'This sign-in has expired or was already used. Start it again from DictProp.',
  },
  // The code is still unspent and the cookies stay, so reloading the page finishes the sign-in.
  busy: {
    status: 503,
    error: 'Sign-in is busy. Try again shortly.',
    page: 'Sign-in is busy. Reload this page in a few seconds to finish signing in.',
  },
  // Google's side of sign-in failed: its token endpoint or its signing keys, not anything the visitor sent.
  googleUnavailable: {
    status: 502,
    error: 'Google sign-in is unavailable',
    page: 'Google sign-in is unavailable. Try again in a few minutes.',
  },
  invalidToken: {
    status: 400,
    error: 'Invalid id_token claims',
    page: 'Google’s answer couldn’t be verified. Start the sign-in again from DictProp.',
  },
  // Anyone's Google account but the owner's, the owner's other account picked by mistake included.
  notOwner: {
    status: 403,
    error: 'This DictProp instance is private.',
    page: 'This DictProp instance is private. If it’s yours, sign in with the Google account that owns it.',
  },
} as const satisfies Record<string, SignInFailure>;

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

/** The page a browser shows for a sign-in that didn't finish: `message`, and a link back to the app. */
export const signInFailurePage = (message: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in didn’t finish · DictProp</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
main { max-width: 28rem; margin: 20vh auto 0; padding: 0 1.5rem; }
h1 { font-size: 1.25rem; }
a { color: #6366f1; font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>Sign-in didn’t finish</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to DictProp</a></p>
</main>
</body>
</html>
`;

/** Answers with `failure`: its page to a request that accepts text/html, a browser's navigation, else its JSON error. */
export function signInFailure(c: Context, failure: SignInFailure): Response {
  return /\btext\/html\b/i.test(c.req.header('Accept') ?? '')
    ? c.html(signInFailurePage(failure.page), failure.status)
    : c.json({ error: failure.error }, failure.status);
}
