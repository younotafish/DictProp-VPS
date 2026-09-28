/** Structural equality for JSON-shaped data, treating a missing key and an undefined value alike. */
export const isSameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => isSameJson(value, b[index]));
  }
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key in left) if (!isSameJson(left[key], right[key])) return false;
  for (const key in right) if (!(key in left) && right[key] !== undefined) return false;
  return true;
};
