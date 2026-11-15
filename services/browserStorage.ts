// Small JSON values kept in localStorage (the review outbox, the refused-review log): the storage to use, and a
// reader that treats a missing or damaged value as absent. Tests pass their own storage.

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const defaultStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
