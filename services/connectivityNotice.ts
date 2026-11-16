/**
 * What going offline changes on screen, as rules node tests can pin. The app's chrome treats the connection as gone
 * only once an outage has lasted OFFLINE_SETTLE_MS (useOnlineStatus's offlineSettled), so a phone losing its signal
 * for a moment changes nothing, and going offline never moves the page: the Offline chip floats in the notice stack,
 * and the controls that need the server stay where they are, disabled with NEEDS_CONNECTION. Whatever the user asks
 * for explicitly (a lookup, a sign-out) still checks the connection the moment it's asked.
 */

/** How long the connection has to stay down before the chrome says so. */
export const OFFLINE_SETTLE_MS = 3_000;

/** Why a control that needs the server is disabled while offline. */
export const NEEDS_CONNECTION = 'Needs a connection';

/** The Notebook header's controls that this module rules on: the ⋯ menu's tools, the compare toggle and Sign out. */
export type HeaderControl =
  | 'analyze' | 'batch' | 'json' | 'images' | 'sync' | 'speech' | 'restore' | 'merge' | 'shortcuts' | 'compare' | 'signout';

const NEEDS_SERVER: ReadonlySet<HeaderControl> = new Set<HeaderControl>([
  'analyze', 'batch', 'json', 'images', 'sync', 'speech', 'restore', 'compare', 'signout',
]);

/**
 * Whether `control` is disabled: offline, everything that needs the server is, while the speech settings, Merge
 * duplicates and the shortcut sheet keep working on the device.
 */
export const networkRowDisabled = (control: HeaderControl, online: boolean): boolean => !online && NEEDS_SERVER.has(control);

/**
 * What the notice stack says about the connection: once an outage has settled, the Offline chip, but only on the tabs;
 * over an open card or the card popup it never shows.
 */
export function connectivityNotice({ offline, onTab }: { offline: boolean; onTab: boolean }): 'hidden' | 'chip' {
  return offline && onTab ? 'chip' : 'hidden';
}
