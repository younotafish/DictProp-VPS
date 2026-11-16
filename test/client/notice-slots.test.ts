import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { noticeSlotRef, readNoticeSlot, subscribeNoticeSlots, useNoticeSlot } from '../../components/noticeSlots.ts';

// components/noticeSlots.ts: the notice stack's slots, published for the portals that fill them. Node has no DOM,
// so plain objects stand in for the slot elements.
const element = (name: string) => ({ name }) as unknown as HTMLElement;

test('each slot has one ref callback, whatever renders it', () => {
  assert.equal(noticeSlotRef('search'), noticeSlotRef('search'));
  assert.notEqual(noticeSlotRef('search'), noticeSlotRef('progress'));
});

test('mounting, replacing and unmounting a slot tell the subscribers; setting the same element again does not', () => {
  let heard = 0;
  const stop = subscribeNoticeSlots(() => { heard++; });
  const setSearch = noticeSlotRef('search');
  const first = element('first');
  const second = element('second');

  setSearch(first);
  assert.equal(readNoticeSlot('search'), first);
  assert.equal(heard, 1);
  setSearch(first);
  assert.equal(heard, 1, 'nothing changed');
  setSearch(second);
  assert.equal(readNoticeSlot('search'), second);
  assert.equal(heard, 2);
  assert.equal(readNoticeSlot('progress'), null, 'the other slot is untouched');
  setSearch(null);
  assert.equal(readNoticeSlot('search'), null);
  assert.equal(heard, 3);

  stop();
  setSearch(first);
  assert.equal(heard, 3, 'a stopped subscriber hears nothing');
  setSearch(null);
});

test('a server render sees no slot, even with one mounted', () => {
  noticeSlotRef('progress')(element('progress'));
  let seen: HTMLElement | null | undefined;
  const Probe = () => { seen = useNoticeSlot('progress'); return null; };
  renderToStaticMarkup(createElement(Probe));
  assert.equal(seen, null);
  noticeSlotRef('progress')(null);
});
