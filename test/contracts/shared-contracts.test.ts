import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { readRepoFile, REPO_ROOT, repoPath } from '../support/paths.ts';

// The sharing rule in server/src/shared/README.md: runtime code both sides execute lives in server/src/shared,
// import-free, and the client reaches the rest of server/src only through type-only imports.

const SHARED_DIR = 'server/src/shared';
const CLIENT_ROOTS = ['App.tsx', 'index.tsx', 'types.ts', 'services', 'components', 'hooks', 'views'];

/** Every .ts and .tsx file under a repository path, as paths from the repository root. */
function sourceFiles(path: string): string[] {
  const absolute = repoPath(path);
  if (!existsSync(absolute)) return [];
  const entries = readdirSync(absolute, { withFileTypes: true, recursive: true });
  return entries
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => relative(REPO_ROOT, join(entry.parentPath, entry.name)));
}

const clientFiles = (): string[] => CLIENT_ROOTS.flatMap(root => /\.tsx?$/.test(root) ? [root] : sourceFiles(root));

function parse(path: string): ts.SourceFile {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, readRepoFile(path), ts.ScriptTarget.Latest, true, kind);
}

interface ModuleReference {
  specifier: string;
  /** Erased by the bundler: `import type`, `export type`. */
  typeOnly: boolean;
  line: number;
}

/** The module references in a file: import and export declarations, import() calls and require() calls. */
function moduleReferences(file: ts.SourceFile): ModuleReference[] {
  const found: ModuleReference[] = [];
  const add = (node: ts.Node, specifier: ts.Expression | undefined, typeOnly: boolean) => {
    const text = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : specifier?.getText(file) ?? '';
    found.push({ specifier: text, typeOnly, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, node.importClause?.isTypeOnly ?? false);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, node.moduleSpecifier, node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node)) add(node, undefined, node.isTypeOnly);
    else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) add(node, node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test('modules in server/src/shared import nothing, so the client, the server and plain node can all load them', () => {
  assert.ok(existsSync(repoPath(SHARED_DIR)), `${SHARED_DIR} exists (the Docker client build copies it)`);
  for (const path of sourceFiles(SHARED_DIR)) {
    for (const reference of moduleReferences(parse(path))) {
      assert.fail(`${path}:${reference.line} imports ${reference.specifier || 'a module'}; shared modules have no imports at all`);
    }
  }
});

test('client code reaches server/src at runtime only through server/src/shared', () => {
  const files = clientFiles();
  assert.ok(files.length > 100, `found ${files.length} client files`);
  const serverSrc = repoPath('server/src');
  const shared = repoPath(SHARED_DIR);
  for (const path of files) {
    for (const reference of moduleReferences(parse(path))) {
      if (!reference.specifier.startsWith('.')) continue;
      const target = resolve(repoPath(dirname(path)), reference.specifier);
      if (!target.startsWith(`${serverSrc}/`) || target.startsWith(`${shared}/`) || reference.typeOnly) continue;
      assert.fail(`${path}:${reference.line} imports ${reference.specifier} at runtime: share it through ${SHARED_DIR}, or use \`import type\` / \`export type\``);
    }
  }
});

test('the Docker client build copies server/src/shared before it builds', () => {
  // Stages run from their FROM line to the next one; the client's is the one that copies vite.config.ts.
  const stages = readRepoFile('Dockerfile').split(/^(?=FROM )/m).filter(stage => stage.startsWith('FROM '));
  const client = stages.filter(stage => /^COPY .*\bvite\.config\.ts\b/m.test(stage));
  assert.equal(client.length, 1, 'one Docker stage builds the client');
  const lines = client[0].split('\n');
  const copy = lines.findIndex(line => /^COPY server\/src\/shared\/ \.\/server\/src\/shared\/$/.test(line));
  const build = lines.findIndex(line => /^RUN npm run build$/.test(line));
  assert.notEqual(build, -1, 'the client stage runs npm run build');
  assert.ok(copy !== -1 && copy < build, 'the client stage copies server/src/shared/ before RUN npm run build');
});
