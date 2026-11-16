import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'dns';
import { lookup } from 'dns/promises';
import { isIP, type LookupFunction } from 'net';
import { isPrivateNetworkAddress } from './ip.js';
import { proxyFetch } from './proxy-fetch.js';

export async function resolvePublicHttpUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('URL must be public HTTP(S)');
  }
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('URL port is not allowed');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Private host is not allowed');
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(result => isPrivateNetworkAddress(result.address))) {
    throw new Error('Private address is not allowed');
  }
  return url;
}

export type AddressResolver = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: AddressResolver = (hostname, options, callback) =>
  dnsLookup(hostname, { ...options, all: true }, callback);

/**
 * A socket `lookup` that refuses private addresses. Checking a host before the request isn't enough: its
 * DNS can answer differently by the time the socket connects (rebinding), so the connection's own lookup
 * is the check that counts. It answers both of Node's callback forms (`all` is set when Node races IPv4
 * and IPv6).
 */
export function createPublicAddressLookup(resolver: AddressResolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, options, (error, addresses) => {
      if (error) {
        callback(error, '');
        return;
      }
      if (addresses.length === 0 || addresses.some(entry => isPrivateNetworkAddress(entry.address))) {
        const refused: NodeJS.ErrnoException = new Error('Private address is not allowed');
        refused.code = 'ERR_PRIVATE_ADDRESS';
        callback(refused, '');
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export const publicAddressLookup = createPublicAddressLookup();

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PublicFetchTransport = (
  url: string,
  init: RequestInit,
  direct: { lookup: LookupFunction },
) => Promise<Response>;

/**
 * Fetch a URL that must stay on the public internet. Redirects are followed by hand, at most
 * `maxRedirects`, so every hop is checked again, and each connection resolves its host through
 * `publicAddressLookup`. A configured proxy (local development only) resolves names itself, so there the
 * check before each hop is the only one.
 */
export async function fetchPublicHttpUrl(
  input: string,
  init: RequestInit = {},
  { maxRedirects = 3, transport = proxyFetch }: { maxRedirects?: number; transport?: PublicFetchTransport } = {},
): Promise<Response> {
  let current = input;
  for (let redirects = 0; ; redirects++) {
    const url = await resolvePublicHttpUrl(current);
    const response = await transport(url.toString(), { ...init, redirect: 'manual' }, { lookup: publicAddressLookup });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Redirect has no location');
    if (redirects >= maxRedirects) throw new Error('Too many redirects');
    current = new URL(location, url).toString();
  }
}
