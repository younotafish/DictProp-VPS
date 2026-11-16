// Predicates the request validator and the import-bundle validators share. Import-free, so a plain-node script
// can load it as well as the server.

const ITEM_TYPES = ['vocab', 'phrase', 'sentence'] as const;
export type ItemType = typeof ITEM_TYPES[number];

export const isItemType = (value: unknown): value is ItemType => (ITEM_TYPES as readonly unknown[]).includes(value);

/** A lowercase hex SHA-256 digest. */
const SHA256_HEX = /^[a-f0-9]{64}$/;

export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256_HEX.test(value);

/** Where an import bundle keeps an image: a plain file name under images/, with an image extension. */
export const SAFE_IMAGE_PATH = /^images\/[A-Za-z0-9._-]+\.(?:avif|jpe?g|png|webp)$/i;

/** A JSON object: not null, and not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
