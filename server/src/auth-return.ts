const AUTH_RETURN_ORIGIN = 'https://dictprop.online';
const LAKE_LOOP_ROOT = '/lake-loop-26';

/**
 * Keep OAuth return targets on this origin and inside the private trip site.
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
  if (target.pathname !== LAKE_LOOP_ROOT && !target.pathname.startsWith(`${LAKE_LOOP_ROOT}/`)) {
    return '/';
  }

  return `${target.pathname}${target.search}${target.hash}`;
}
