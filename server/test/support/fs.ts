import { createHash } from 'node:crypto';

/** The SHA-256 of text or bytes, in hex. */
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Bytes that pass the server's PNG signature check, distinct per seed. */
export const png = (seed: string): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
