export interface OwnerUserRecord {
  email: string;
  is_admin: number;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function isOwnerUser(user: OwnerUserRecord, configuredOwnerEmail = ''): boolean {
  if (user.is_admin !== 1) return false;
  const configured = normalizeEmail(configuredOwnerEmail);
  return !configured || normalizeEmail(user.email) === configured;
}

export function ownerLoginDecision(
  existingUser: OwnerUserRecord | null,
  presentedEmail: string,
  userCount: number,
  configuredOwnerEmail = '',
): 'allow' | 'bootstrap' | 'deny' {
  const configured = normalizeEmail(configuredOwnerEmail);
  if (configured && normalizeEmail(presentedEmail) !== configured) return 'deny';
  if (existingUser) return isOwnerUser(existingUser, configuredOwnerEmail) ? 'allow' : 'deny';
  return userCount === 0 && configured ? 'bootstrap' : 'deny';
}
