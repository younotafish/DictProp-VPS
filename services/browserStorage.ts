// Small JSON values kept in web storage, localStorage or, for what lasts only as long as the tab, sessionStorage: the
// storage to use, and the one reader for a stored value, which treats a missing or damaged value as absent. Tests pass
// their own storage.

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage, or null where there's none or the browser refuses access to it. */
export const defaultStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** sessionStorage, or null where there's none or the browser refuses access to it. */
export const defaultSessionStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

/** A stored value read as JSON, or null when it's missing or isn't JSON. Never throws. */
export const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
