// Server replies are checked before views render them: these keep only well-formed values.

export const textOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');

// Only string values survive: the comparison view renders these maps directly.
export const stringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};
