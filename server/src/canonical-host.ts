// dictprop.online is the one canonical origin: Google returns every sign-in to it, so the sign-in cookies a
// www.dictprop.online login set never came back and the sign-in failed. www requests are sent to the apex.
export const CANONICAL_ORIGIN = 'https://dictprop.online';
const WWW_HOST = 'www.dictprop.online';

/** The host the visitor asked for, as Caddy forwards it, lowercased and without a port. */
export function requestedHost(req: { header(name: string): string | undefined }): string {
  const host = req.header('x-forwarded-host') || req.header('host') || '';
  return host.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

export const isWwwHost = (host: string): boolean => host === WWW_HOST;
