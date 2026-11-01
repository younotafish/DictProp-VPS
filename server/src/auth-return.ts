const AUTH_RETURN_ORIGIN = 'https://dictprop.online';
/** The private static sites behind Caddy's forward-auth gate: the trip site and the SD flashcards. */
const PRIVATE_SITE_ROOTS = ['/lake-loop-26', '/sd-cards'];

/**
 * Keep OAuth return targets on this origin and inside one of the private static sites.
 * The main DictProp client continues to use the default `/` target.
 */
export function sanitizeAuthReturnTo(value: string | null | undefined): string {
  if (!value) return '/';

  let target: URL;
  try {
    target = new URL(value, AUTH_RETURN_ORIGIN);
  } catch {
    return '/';
  }

  if (target.origin !== AUTH_RETURN_ORIGIN) return '/';
  const { pathname } = target;
  if (!PRIVATE_SITE_ROOTS.some(root => pathname === root || pathname.startsWith(`${root}/`))) {
    return '/';
  }

  return `${target.pathname}${target.search}${target.hash}`;
}
