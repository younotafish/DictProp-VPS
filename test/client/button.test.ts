import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../../components/Button.tsx';

const render = (props: Parameters<typeof Button>[0]) => renderToStaticMarkup(createElement(Button, props));
const classesOf = (html: string) => html.match(/class="([^"]*)"/)![1].split(/\s+/).filter(Boolean);

test('a Button is type="button" unless told otherwise, so it never submits a form', () => {
  assert.match(render({ children: 'Save' }), /^<button type="button" /);
  assert.match(render({ type: 'submit', children: 'Go' }), /^<button type="submit" /);
});

test('the variant and size add their classes before the caller\'s, and plain adds no colour of its own', () => {
  const primary = classesOf(render({ children: 'OK', className: 'flex-1' }));
  assert.ok(primary.includes('bg-indigo-600') && primary.includes('px-4') && primary.at(-1) === 'flex-1');
  const plain = classesOf(render({ variant: 'plain', size: 'sm', className: 'bg-rose-500 text-white', children: 'Delete' }));
  assert.deepEqual(plain.filter(c => /^(bg|text|shadow|border)-/.test(c)), ['text-sm', 'bg-rose-500', 'text-white']);
  assert.ok(plain.includes('rounded-xl') && plain.includes('px-3'));
});
