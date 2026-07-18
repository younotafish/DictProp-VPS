export interface OfflineImageEntry {
  parentId: string;
  imageId: string;
  parentHash: string;
  imageFile: string;
}

export interface OfflineImageBundle {
  version: 1;
  generatedAt: number;
  model: string;
  entries: OfflineImageEntry[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IMAGE_PATH = /^images\/[A-Za-z0-9._-]+\.(?:avif|jpe?g|png|webp)$/i;

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateOfflineImageBundle(value: unknown): string | null {
  if (!isRecord(value)) return 'bundle must be an object';
  if (value.version !== 1) return 'unsupported bundle version';
  if (typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt) || value.generatedAt <= 0) {
    return 'bundle generatedAt is invalid';
  }
  if (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 200) {
    return 'bundle model is invalid';
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 20_000) {
    return 'bundle entries must contain 1 to 20000 records';
  }
  const ids = new Set<string>();
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    if (!isRecord(entry)) return `entry ${index} must be an object`;
    if (typeof entry.parentId !== 'string' || entry.parentId.length === 0 || entry.parentId.length > 200) {
      return `entry ${index} parentId is invalid`;
    }
    if (typeof entry.imageId !== 'string' || entry.imageId.length === 0 || entry.imageId.length > 200) {
      return `entry ${index} imageId is invalid`;
    }
    if (ids.has(entry.imageId)) return `entry ${index} duplicates image id ${entry.imageId}`;
    ids.add(entry.imageId);
    if (typeof entry.parentHash !== 'string' || !SHA256.test(entry.parentHash)) {
      return `entry ${index} parentHash is invalid`;
    }
    if (typeof entry.imageFile !== 'string' || !SAFE_IMAGE_PATH.test(entry.imageFile)) {
      return `entry ${index} imageFile is invalid`;
    }
  }
  return null;
}
