import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { readRepoFile, repoPath } from '../support/paths.ts';

// The app's first chunk is the JavaScript every launch downloads before the first screen, within a 100 kB gzip
// budget (scripts/check-bundle-budget.mjs). Rollup puts each module that index.tsx reaches through static imports
// into it, whole. The modules below load with import() when first used, so no static import from the entry may
// reach them. A listed module that doesn't exist yet counts as unreachable: the list names the lazy modules still
// to come too, so none of them can join the first chunk when it lands.
const LAZY_ONLY = [
  'services/api/ai.ts',
  'services/api/tts.ts',
  'services/externalLinks.ts',
  'services/libraryTools.ts',
  'services/speechSweep.ts',
  'services/neuralTts.ts',
  'services/audio/player.ts',
  'services/platform.ts',
  'services/actionGuards.ts',
  'services/senseSaving.ts',
  'services/refreshReplace.ts',
  'services/shortcutSheet.ts',
  'services/jobNotices.ts',
  'services/lessonTrail.ts',
  'services/studySessionRecord.ts',
  'components/AppGateScreens.tsx',
  'services/authGate.ts',
  'services/catalogQueue.ts',
  'services/reviewGestures.ts',
  'services/studyKeys.ts',
  'services/studyPrompt.ts',
  'services/notebook/listScroll.ts',
  'services/notebook/listView.ts',
  'services/notebook/searchBox.ts',
  'services/notebook/searchRank.ts',
  'services/readingPosition.ts',
  'components/activateOnKey.ts',
  'services/reviewHistory.ts',
];

const ENTRY = 'index.tsx';

/**
 * The relative specifiers a module imports statically: the edges Rollup follows into the first chunk. What the
 * build erases is no edge (`import type`, `export type`, and imports or re-exports whose names are all marked
 * `type`, which esbuild drops whole), and neither is import(), which loads its module when it runs.
 */
function staticImports(source: string, fileName: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const onlyTypes = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(element => element.isTypeOnly)));
      if (!onlyTypes) specifier = statement.moduleSpecifier;
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const onlyTypes = statement.isTypeOnly || (!!statement.exportClause && ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.every(element => element.isTypeOnly));
      if (!onlyTypes) specifier = statement.moduleSpecifier;
    }
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) specifiers.push(specifier.text);
  }
  return specifiers;
}

/** The TypeScript module a relative specifier names, as Vite resolves it, or null for anything else (CSS, JSON, a ?url asset). */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (specifier.includes('?')) return null;
  const base = join(dirname(fromFile), specifier);
  const candidates = /\.tsx?$/.test(base) ? [base] : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find(path => existsSync(repoPath(path)) && statSync(repoPath(path)).isFile()) ?? null;
}

/** Every module the entry reaches through static imports, each with the module that first imported it. */
function firstChunkModules(): Map<string, string | null> {
  const importedBy = new Map<string, string | null>([[ENTRY, null]]);
  const queue = [ENTRY];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const specifier of staticImports(readRepoFile(file), file)) {
      const target = resolveModule(file, specifier);
      if (target === null || importedBy.has(target)) continue;
      importedBy.set(target, file);
      queue.push(target);
    }
  }
  return importedBy;
}

/** The chain of static imports from the entry to `module`. */
function importChain(importedBy: ReadonlyMap<string, string | null>, module: string): string {
  const chain: string[] = [];
  for (let at: string | null | undefined = module; at; at = importedBy.get(at)) chain.unshift(at);
  return chain.join(' -> ');
}

test('only static imports are edges: type-only imports and re-exports, and import(), are not', () => {
  const source = [
    "import React from 'react';",
    "import Default from './default';",
    "import * as everything from './namespace';",
    "import { value, type OnlyAType } from './mixed';",
    "import './styles.css';",
    "import './side-effect';",
    "import type { Erased } from './type-only';",
    "import { type AlsoErased, type ErasedToo } from './inline-types';",
    "export { reexported } from './reexport';",
    "export * from './star';",
    "export type { ErasedExport } from './type-export';",
    "export { type InlineErasedExport } from './inline-type-export';",
    "const later = () => import('./dynamic');",
    "// import { commented } from './comment';",
    "const text = \"import { quoted } from './string'\";",
  ].join('\n');
  assert.deepEqual(
    staticImports(source, 'sample.ts'),
    ['./default', './namespace', './mixed', './styles.css', './side-effect', './reexport', './star'],
  );
});

test('the first chunk reaches none of the modules that load with import()', () => {
  const modules = firstChunkModules();
  for (const module of ['App.tsx', 'hooks/useLibrary.ts']) assert.ok(modules.has(module), `the walk reaches ${module}`);
  const reached = LAZY_ONLY.filter(module => modules.has(module)).map(module => importChain(modules, module));
  assert.deepEqual(reached, [], [
    'The first chunk statically imports modules that must load with import():',
    ...reached,
    'Load them with import(), or import only their types (`import type`).',
  ].join('\n'));
});
