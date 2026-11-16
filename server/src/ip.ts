import { isIP } from 'net';

// Which network an IP address belongs to: the SSRF guard refuses private targets, and the sign-in limits trust
// a forwarded client address only from a private peer.

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

/** The eight 16-bit groups of an IPv6 address (a trailing dotted quad included), or null when it isn't one. */
export function parseIpv6(input: string): number[] | null {
  const address = input.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (isIP(address) !== 6) return null;
  let hexadecimal = address;
  const dotted = hexadecimal.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    hexadecimal = hexadecimal.slice(0, -dotted.length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = hexadecimal.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right]
    .map(part => Number.parseInt(part || '0', 16));
  if (parts.length !== 8 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  return parts;
}

export function isPrivateNetworkAddress(input: string): boolean {
  const address = input.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const parts = parseIpv6(address);
  if (!parts) return true;
  if (parts.every(part => part === 0) || (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1)) return true;
  if (parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) {
    return isPrivateIpv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  const first = parts[0];
  return (first & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00; // multicast ff00::/8
}
