// The themes Today groups saved words and sentences into: a closed list of real-life scenes in domains. The server's
// classifier (server/src/themes) assigns each item one theme id; the client plans sets from those ids
// (services/learningLoop). Ids are stable and never reused: a renamed scene keeps its id, and a scene that is split
// or retired gets new ids while its old one is dropped, so a client that doesn't know an id treats the item as
// unsorted. Bump THEME_TAXONOMY_VERSION when the list changes; the server then re-labels only items whose theme left.
// The classifier's boundary notes, which only its prompt needs, live in server/src/themes/boundaries.ts.

export const THEME_TAXONOMY_VERSION = 1;

export interface ThemeInfo {
  id: string;
  title: string;
  emoji: string;
  /** The situation, in a phrase. */
  blurb: string;
  /** The id of the domain it belongs to. */
  domain: string;
}

export interface ThemeDomain {
  id: string;
  title: string;
  emoji: string;
  themes: readonly ThemeInfo[];
}

type SceneRow = readonly [id: string, title: string, emoji: string, blurb: string];
type DomainRow = readonly [id: string, title: string, emoji: string, scenes: readonly SceneRow[]];

// PLACEHOLDER: replaced by the designed taxonomy before release.
const DOMAIN_ROWS: readonly DomainRow[] = [
  ['food-dining', 'Food & dining', '🍽️', [
    ['cooking-at-home', 'Cooking at home', '🍳', 'Recipes, prep and kitchen techniques'],
    ['eating-out', 'Eating out', '🍝', 'Ordering, service and the bill at restaurants and bars'],
  ]],
  ['home-life', 'Home life', '🏠', [
    ['home-repairs', 'Fixing things at home', '🔧', 'Tools, repairs, plumbing and wiring'],
    ['chores-cleaning', 'Chores and cleaning', '🧹', 'Laundry, cleaning and tidying up'],
  ]],
];

export const THEME_DOMAINS: readonly ThemeDomain[] = DOMAIN_ROWS.map(([id, title, emoji, scenes]) => ({
  id,
  title,
  emoji,
  themes: scenes.map(([themeId, themeTitle, themeEmoji, blurb]) => ({
    id: themeId, title: themeTitle, emoji: themeEmoji, blurb, domain: id,
  })),
}));

/** Every theme, in domain order. */
export const THEMES: readonly ThemeInfo[] = THEME_DOMAINS.flatMap(domain => domain.themes);

const THEMES_BY_ID = new Map(THEMES.map(theme => [theme.id, theme]));

export const themeById = (id: string): ThemeInfo | undefined => THEMES_BY_ID.get(id);

export const isThemeId = (value: unknown): value is string => typeof value === 'string' && THEMES_BY_ID.has(value);

/** GET /api/themes: the theme rows changed after the asked sequence number, and how the server's sorting stands. */
export interface ThemesResponse {
  taxonomyVersion: number;
  /** [itemId, themeId], in sequence order; a null theme means the item has none any more. */
  rows: Array<[string, string | null]>;
  /** The sequence number to ask after next time. */
  latestSeq: number;
  /** Items still waiting for a theme. */
  pending: number;
  status: 'idle' | 'running' | 'paused';
  /** Why the last sweep stopped early, when it did. */
  lastError?: string;
}
