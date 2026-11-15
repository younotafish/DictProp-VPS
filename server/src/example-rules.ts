// What makes a generated example usable: exactly one plain {{target}} around the studied word, at most four
// non-empty [[lookups]], no stray brackets, and two examples that are different sentences. The live analysis
// repairs and validates against these rules, and the stall audit judges stored cards by them.
//
// Imported by scripts/offline under plain node, so this module has no imports at all: Node's type stripping
// cannot map a relative './x.js' import to its .ts file.

/** An example reduced to its wording: markers removed, Unicode-normalized, lowercased, spaces collapsed. */
export const exampleIdentity = (value: string): string => value
  .replace(/\{\{([^{}]+)\}\}/g, '$1')
  .replace(/\[\[([^[\]]+)\]\]/g, '$1')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

/** Why an example fails isValidGeneratedExample, in words the model can act on. Empty when it passes. */
export function exampleIssues(value: unknown): string[] {
  if (typeof value !== 'string') return ['must be a string'];
  const issues: string[] = [];
  if (value.trim().length < 20) issues.push('must be at least 20 characters');
  if (value.length > 1_000) issues.push('must be at most 1000 characters');
  const targets = [...value.matchAll(/\{\{([^{}]+)\}\}/g)];
  if (targets.length !== 1) {
    issues.push(`must wrap the studied word in {{double curly braces}} exactly once (found ${targets.length})`);
  } else if (!targets[0][1].trim() || /\[\[|\]\]/.test(targets[0][1])) {
    issues.push('the {{target}} must be plain, non-empty text');
  }
  const lookups = [...value.matchAll(/\[\[([^[\]]+)\]\]/g)];
  if (lookups.length > 4) issues.push(`must have at most 4 [[lookup]] markers (found ${lookups.length})`);
  if (lookups.some(match => !match[1].trim())) issues.push('[[lookup]] markers must not be empty');
  const remainder = value.replace(/\{\{[^{}]+\}\}/g, '').replace(/\[\[[^[\]]+\]\]/g, '');
  if (/[{}[\]]/.test(remainder)) issues.push('must not contain stray { } [ ] characters outside the markers');
  return issues;
}

/** Why an example set fails isValidGeneratedExampleSet, one reason per problem. */
export function exampleSetIssues(value: unknown): string[] {
  if (!Array.isArray(value)) return ['"examples" must be an array of exactly 2 sentences'];
  const issues: string[] = [];
  if (value.length !== 2) issues.push(`"examples" must contain exactly 2 sentences (found ${value.length})`);
  value.slice(0, 2).forEach((example, index) => {
    for (const issue of exampleIssues(example)) issues.push(`example ${index + 1} ${issue}`);
  });
  if (value.length === 2 && value.every(example => typeof example === 'string') &&
      new Set(value.map(exampleIdentity)).size < 2) {
    issues.push('the two examples must be different sentences');
  }
  return issues;
}

export function isValidGeneratedExample(value: unknown): value is string {
  return exampleIssues(value).length === 0;
}

export function isValidGeneratedExampleSet(value: unknown): value is [string, string] {
  return exampleSetIssues(value).length === 0;
}
