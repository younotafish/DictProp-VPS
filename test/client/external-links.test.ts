import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ReactElement } from 'react';
import { ExternalLinkChip, chipClassName } from '../../components/ExternalLinkChip.tsx';
import {
  EXTERNAL_NAV_EVENT,
  chatGptUrl,
  ngramUrl,
  tiktokUrl,
  wordCardLinks,
  youglishUrl,
} from '../../services/externalLinks.ts';

const events: string[] = [];
const opened: unknown[][] = [];
let openThrows = false;
const hadWindow = 'window' in globalThis;
before(() => {
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (event: Event) => { events.push(event.type); return true; },
    open: (...args: unknown[]) => { opened.push(args); if (openThrows) throw new Error('blocked'); return null; },
  };
});
after(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

test('links encode the word: spaces, accents and ampersands', () => {
  assert.equal(youglishUrl('café & co'), 'https://youglish.com/pronounce/caf%C3%A9%20%26%20co/english/us');
  assert.equal(ngramUrl('a&b'), 'https://books.google.com/ngrams/graph?content=a%26b&year_start=1800&year_end=2019&corpus=en&smoothing=3');
  assert.equal(tiktokUrl('break the ice', true), 'https://www.tiktok.com/discover/break%20the%20ice');
  assert.equal(tiktokUrl('break the ice', false), 'https://www.tiktok.com/search?q=break%20the%20ice');
});

test('ChatGPT gets the translator prompt and the text in double quotes, unless it is already quoted', () => {
  const textOf = (url: string) => {
    assert.ok(url.startsWith('https://chatgpt.com/?q='));
    return decodeURIComponent(url.slice('https://chatgpt.com/?q='.length));
  };
  const plain = textOf(chatGptUrl('touché'));
  assert.ok(plain.startsWith('You are an American English ↔ Chinese visual translator.'));
  assert.ok(plain.endsWith('Do not add anything else.\n\n"touché"'));
  assert.ok(textOf(chatGptUrl('  "already quoted"  ')).endsWith('\n\n"already quoted"'));
  assert.ok(textOf(chatGptUrl(' spaced ')).endsWith('\n\n" spaced "'), 'unquoted text is wrapped as typed');
});

test('a word card links seven resources; TikTok and ChatGPT stay in the tab where iOS or a phone hands them to an app', () => {
  const desktop = wordCardLinks('ice', { isIOS: false, isMobile: false });
  assert.deepEqual(desktop.map(link => link.label), ['Vocabulary.com', 'YouTube', 'TikTok', 'PlayPhrase', 'Wiktionary', 'Ngram', 'ChatGPT']);
  assert.deepEqual(desktop.map(link => link.opening), ['window-open', 'new-tab', 'new-tab', 'new-tab', 'new-tab', 'new-tab', 'new-tab']);
  const iphone = wordCardLinks('ice', { isIOS: true, isMobile: true });
  assert.deepEqual(iphone.map(link => link.opening), ['window-open', 'new-tab', 'same-tab', 'new-tab', 'new-tab', 'new-tab', 'same-tab']);
  assert.equal(iphone[2].href, 'https://www.tiktok.com/discover/ice');
  const android = wordCardLinks('ice', { isIOS: false, isMobile: true });
  assert.deepEqual([android[2].opening, android[6].opening], ['new-tab', 'same-tab']);
});

type Chip = ReactElement<{ target?: string; rel?: string; href?: string; onClick: (event: { stopPropagation(): void }) => void }>;
const tap = (chip: Chip) => {
  let stopped = false;
  chip.props.onClick({ stopPropagation: () => { stopped = true; } });
  return stopped;
};

test('a chip keeps the tap from the card and saves before leaving; window-open survives a blocked popup', () => {
  const common = { href: 'https://example.com/x', label: 'X', title: 'X', className: chipClassName('sky') };
  const newTab = ExternalLinkChip({ ...common, opening: 'new-tab' }) as Chip;
  assert.equal(newTab.type, 'a');
  assert.deepEqual([newTab.props.target, newTab.props.rel], ['_blank', 'noopener noreferrer']);
  events.length = 0;
  assert.equal(tap(newTab), true);
  assert.deepEqual(events, [EXTERNAL_NAV_EVENT]);

  const sameTab = ExternalLinkChip({ ...common, opening: 'same-tab' }) as Chip;
  assert.deepEqual([sameTab.props.target, sameTab.props.rel, sameTab.props.href], [undefined, undefined, common.href]);

  const button = ExternalLinkChip({ ...common, opening: 'window-open' }) as Chip;
  assert.equal(button.type, 'button');
  events.length = 0;
  opened.length = 0;
  tap(button);
  assert.deepEqual(events, [EXTERNAL_NAV_EVENT]);
  assert.deepEqual(opened, [[common.href, '_blank', 'noopener,noreferrer']]);
  openThrows = true;
  try {
    assert.equal(tap(button), true);
  } finally {
    openThrows = false;
  }
});
