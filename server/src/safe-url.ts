import { lookup } from 'dns/promises';
import { isIP } from 'net';

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19));
}

export function isPrivateNetworkAddress(input: string): boolean {
  const address = input.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) !== 6) return true;
  let hexadecimal = address;
  const dotted = hexadecimal.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    hexadecimal = hexadecimal.slice(0, -dotted.length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = hexadecimal.split('::');
  if (halves.length > 2) return true;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return true;
  const parts = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right]
    .map(part => Number.parseInt(part || '0', 16));
  if (parts.length !== 8 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) return true;
  if (parts.every(part => part === 0) || (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1)) return true;
  if (parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) {
    return isPrivateIpv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  const first = parts[0];
  return (first & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00; // multicast ff00::/8
}

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
