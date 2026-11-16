import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readRepoFile } from '../support/paths.ts';

// App.tsx's wiring that no rendered test reaches, read from its source: the signed-in app needs a browser to mount.

test('the search\'s error boundary forgets the pending searches as it catches, so closing it or reloading starts afresh', () => {
  // Otherwise Close, Reload App or a browser reload runs the crashed search's requests again, bringing back a result
  // that crashes it whenever it's opened (components/ErrorBoundary calls onError as it catches).
  const source = readRepoFile('App.tsx');
  const app = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const searches: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'GlobalSearch') searches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.equal(searches.length, 1, 'App renders the search once');
  const boundary = searches[0].parent;
  assert.ok(ts.isJsxElement(boundary) && boundary.openingElement.tagName.getText() === 'ErrorBoundary', 'right inside an error boundary');
  const onError = boundary.openingElement.attributes.properties
    .find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'onError');
  assert.equal(onError?.initializer?.getText(), '{clearPendingSearches}');
  assert.match(source, /^import \{ clearPendingSearches \} from '\.\/services\/searchSessionKeys';$/m, 'the search\'s own');
});

test('the pills in the notice stack fail quietly, not with a dialog the stack would leave unpressable', () => {
  // The notice stack takes no clicks (pointer-events-none) and is translated, so a crash dialog drawn inside it could
  // be neither pressed nor, on a phone without Escape, closed, while it made the page behind it inert.
  const source = readRepoFile('App.tsx');
  const app = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const variants = new Map<string, string | undefined>();
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ['JobPills', 'StuckSyncPill', 'RefusedChangesNotice'].includes(node.tagName.getText())) {
      const element = ts.isJsxSelfClosingElement(node) ? node : node.parent;
      const boundary = element.parent;
      assert.ok(ts.isJsxElement(boundary) && boundary.openingElement.tagName.getText() === 'ErrorBoundary', `${node.tagName.getText()} sits right inside an error boundary`);
      const variant = boundary.openingElement.attributes.properties
        .find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'variant');
      variants.set(node.tagName.getText(), variant?.initializer?.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(app);
  assert.deepEqual(Object.fromEntries(variants), { JobPills: '"quiet"', StuckSyncPill: '"quiet"', RefusedChangesNotice: '"quiet"' });
});
