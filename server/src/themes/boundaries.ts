// The classifier's boundary note for each theme: what belongs there, and where the look-alikes go instead. Only the
// prompt reads them (classifier.ts), so they stay on the server, keyed by the shared taxonomy's ids
// (shared/item-themes.ts); a test checks that both lists hold the same ids.

// PLACEHOLDER: replaced, with the taxonomy itself, by the designed taxonomy's notes before release.
export const THEME_BOUNDARIES: Readonly<Record<string, string>> = {
  'cooking-at-home': 'Kitchen tools, ingredients being prepared and cooking methods (zest, simmer, colander). Ordering food → Eating out',
  'eating-out': 'Restaurants, cafes and bars: tables, menus, service, tips and the bill. Making food yourself → Cooking at home',
  'home-repairs': 'Tools, fixing and installing things, plumbing and wiring (wrench, leak, caulk). Keeping a home tidy → Chores and cleaning',
  'chores-cleaning': 'Laundry, dishes, dusting and tidying (bleach, fold, declutter). Fixing what is broken → Fixing things at home',
};
