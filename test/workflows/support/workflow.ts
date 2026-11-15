import { readdirSync } from 'node:fs';
import { readRepoFile, repoPath } from '../../support/paths.ts';

// Reads the workflows, and the parts of them the tests check, as text. The workflows keep to a small part of
// YAML: block mappings, `- ` sequences, plain one-line values and `|` block scalars. What these helpers would
// misread, a folded `>` scalar or a quoted run value, throws instead of silently dropping out of a check.

export interface Workflow {
  name: string;
  text: string;
}

/** A workflow file's text, by its name in .github/workflows. */
export const readWorkflow = (name: string): string => readRepoFile(`.github/workflows/${name}`);

/** Every workflow file. */
export const loadWorkflows = (): Workflow[] => readdirSync(repoPath('.github/workflows'))
  .filter(name => /\.ya?ml$/.test(name))
  .sort()
  .map(name => ({ name, text: readWorkflow(name) }));

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The workflow's jobs by id: each runs from its two-space-indented key to the next one. */
export function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const result = new Map<string, string>();
  const keys = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  keys.forEach((match, index) => {
    result.set(match[1], body.slice(match.index, keys[index + 1]?.index ?? body.length));
  });
  return result;
}

/** Every step of every job, each from its `- ` line up to the next step or the end of its job. */
export function steps(text: string): string[] {
  const lines = text.split('\n');
  const result: string[] = [];
  lines.forEach((line, index) => {
    if (!/^\s*steps:\s*$/.test(line)) return;
    const first = lines.findIndex((candidate, at) => at > index && candidate.trim() !== '' && !candidate.trim().startsWith('#'));
    if (first === -1 || !lines[first].trimStart().startsWith('- ')) return;
    const itemIndent = indentOf(lines[first]);
    let start = first;
    for (let at = first + 1; at <= lines.length; at += 1) {
      const current = lines[at];
      const ends = current === undefined || (current.trim() !== '' && indentOf(current) < itemIndent);
      if (ends || (indentOf(current) === itemIndent && current.trimStart().startsWith('- '))) {
        result.push(lines.slice(start, at).join('\n').trimEnd());
        if (ends) break;
        start = at;
      }
    }
  });
  return result;
}

/** The lines under `key:` at the given indentation, up to the next line indented no deeper. */
export function entry(text: string, key: string, indent: number): string {
  const lines = text.split('\n');
  const head = `${' '.repeat(indent)}${key}:`;
  const start = lines.findIndex(line => line === head || line.startsWith(`${head} `));
  if (start === -1) throw new Error(`${key}: at indentation ${indent} not found`);
  const end = lines.findIndex((line, index) => index > start && line.trim() !== '' && !line.startsWith(' '.repeat(indent + 1)));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** A mapping's settings, without comments. */
export const settings = (body: string): string[] => body.split('\n')
  .map(line => line.trim())
  .filter(line => line !== '' && !line.startsWith('#'));

interface KeyValue {
  key: string;
  /** A block scalar's content, or a one-line value as written, without a trailing comment. */
  value: string;
  isBlock: boolean;
  /** Where the key is, 1-based, for messages. */
  line: number;
}

/**
 * Every `key: value` and `- key: value` line in the text, in order, outside block scalars. A block scalar's content
 * follows YAML: it is indented deeper than its key, ends at the first line indented less than its first line, and
 * keeps one final newline (`|`), none (`|-`) or all of them (`|+`).
 */
function keyValues(text: string): KeyValue[] {
  const lines = text.split('\n');
  const result: KeyValue[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = /^(\s*)(?:- )?([\w.-]+):(?:\s+(.*?))?\s*$/.exec(lines[index]);
    if (!match || lines[index].trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    const value = (match[3] ?? '').replace(/(?:^|\s+)#.*$/, '');
    const where = `${match[2]} on line ${index + 1}`;
    if (!/^[|>]/.test(value)) {
      result.push({ key: match[2], value, isBlock: false, line: index + 1 });
      index += 1;
      continue;
    }
    if (!/^\|[+-]?$/.test(value)) throw new Error(`${where}: block scalar "${value}" is not one these tests read; use |, |- or |+`);
    const keyIndent = indentOf(lines[index]);
    const body: string[] = [];
    let contentIndent = -1;
    let end = index + 1;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      if (contentIndent === -1) contentIndent = indentOf(line);
      if (contentIndent <= keyIndent || indentOf(line) < contentIndent) break;
      body.push(line.slice(contentIndent));
    }
    let trailing = 0;
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
      trailing += 1;
    }
    const content = body.join('\n');
    const chomped = content === '' || value === '|-' ? content : `${content}\n${value === '|+' ? '\n'.repeat(trailing) : ''}`;
    result.push({ key: match[2], value: chomped, isBlock: true, line: index + 1 });
    // Blank lines after the block belong to whatever follows it.
    index = end - trailing;
  }
  return result;
}

/** Fills in the given workflow expressions, such as `${{ github.sha }}`, and leaves the others as they are. */
const fill = (script: string, expressions: Record<string, string>): string =>
  script.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (expression, name: string) => expressions[name] ?? expression);

/** Every `key: |` block scalar in the text, dedented, with the given workflow expressions filled in. */
export const blocks = (text: string, key: string, expressions: Record<string, string> = {}): string[] => keyValues(text)
  .filter(item => item.key === key && item.isBlock)
  .map(item => fill(item.value, expressions));

/** The first `key: |` block scalar in the text, dedented, with the given workflow expressions filled in. */
export function block(text: string, key: string, expressions: Record<string, string> = {}): string {
  const [first] = blocks(text, key, expressions);
  if (first === undefined) throw new Error(`no ${key}: | block`);
  return first;
}

/** Every `run:` value in the text, one-line or block, in order. */
export const runs = (text: string): string[] => keyValues(text)
  .filter(item => item.key === 'run')
  .map(item => {
    if (!item.isBlock && /^['"]/.test(item.value)) throw new Error(`run on line ${item.line}: quoted run values are not read by these tests`);
    return item.value;
  });
