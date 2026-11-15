type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } };

/** A Mac, or an iPad presenting itself as one ('MacIntel'): its shortcuts use ⌘ rather than Ctrl. */
export const isMacPlatform = (): boolean => {
  const nav = navigator as NavigatorWithUserAgentData;
  return nav.userAgentData?.platform === 'macOS' || !!nav.platform?.includes('Mac');
};

/** The modifier key a shortcut hint names: ⌘ on a Mac, Ctrl elsewhere. */
export const modifierKeyLabel = (): string => (isMacPlatform() ? '⌘' : 'Ctrl');
