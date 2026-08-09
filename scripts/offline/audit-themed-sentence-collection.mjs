#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnCodex } from './codex-process.mjs';

const [collectionArg, briefArg, outputArg] = process.argv.slice(2);
if (!collectionArg || !briefArg || !outputArg) {
  throw new Error('Usage: audit-themed-sentence-collection.mjs <collection.json> <brief.json> <report.json>');
}

const collection = JSON.parse(readFileSync(resolve(collectionArg), 'utf8'));
const brief = JSON.parse(readFileSync(resolve(briefArg), 'utf8'));
const outputPath = resolve(outputArg);
const workDir = resolve(dirname(outputPath), 'audit-work');
mkdirSync(workDir, { recursive: true });

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes_required'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sectionId', 'sentenceNumber', 'severity', 'reason', 'replacementText', 'replacementFocus'],
        properties: {
          sectionId: { type: 'string', minLength: 1 },
          sentenceNumber: { type: 'integer', minimum: 1, maximum: 50 },
          severity: { type: 'string', enum: ['must_fix', 'should_fix'] },
          reason: { type: 'string', minLength: 8, maxLength: 400 },
          replacementText: { type: 'string', minLength: 35, maxLength: 280 },
          replacementFocus: { type: 'string', minLength: 2, maxLength: 80 },
        },
      },
    },
  },
};
const schemaPath = resolve(workDir, 'schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const compact = {
  collection: {
    id: collection.id,
    title: collection.title,
    level: collection.level,
    description: collection.description,
  },
  principles: brief.methodology,
  requirements: brief.requirements,
  sections: collection.sections.map(section => ({
    id: section.id,
    title: section.title,
    description: section.description,
    guidance: brief.sections.find(candidate => candidate.id === section.id)?.guidance || '',
    sentences: section.sentences.map((sentence, index) => ({
      number: index + 1,
      text: sentence.text,
      focus: sentence.focus,
    })),
  })),
};

const prompt = `You are the final senior American-English dialogue editor for an advanced ESL memorization app.

Audit EVERY supplied utterance and the collection as a whole. Return only genuine issues; do not suggest subjective rewrites merely because another wording is possible.

Flag an entry when any of these is true:
- It is not something the implied speaker would naturally say aloud in present-day American English.
- The scenario, policy claim, role, or conversational move is implausible, misleading, unsafe, or internally inconsistent.
- It is generic advice, written boilerplate, or narration rather than a usable spoken utterance.
- It materially belongs in another section or wastes its section slot by repeating a scenario already covered elsewhere.
- It is a close semantic duplicate of another line, even when the words differ.
- Its focus is not an exact contiguous span, is too elementary to merit B2+ study, or is not the most useful learnable expression in the line.
- It has a grammar, punctuation, idiom, register, or clarity defect.

The target is natural B2-C1 speech, not ornate prose. Preserve a balanced mix of traveler/customer and staff responses. Accessibility, safety, allergy, and dispute language are valuable, but repeated versions must not crowd out routine scenarios.

For each issue, provide a complete original replacement that stays in the SAME section, adds a scenario or conversational move not already represented anywhere in the collection, remains 8-32 words, and contains replacementFocus verbatim. Use severity must_fix only for clear defects; use should_fix for meaningful redundancy or weak pedagogical value. If there are no genuine issues, return verdict pass and an empty issues array.

COLLECTION:\n${JSON.stringify(compact)}`;

const child = spawnCodex([
  'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
  '-m', process.env.CODEX_MODEL || 'gpt-5.6-sol', '--output-schema', schemaPath, '-o', outputPath, '-',
]);
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
child.stdin.end(prompt);
const exitCode = await new Promise((accept, reject) => {
  child.on('error', reject);
  child.on('exit', code => accept(code));
});
if (exitCode !== 0) throw new Error(`Codex audit failed with ${exitCode}: ${stderr}`);

const report = JSON.parse(readFileSync(outputPath, 'utf8'));
const sections = new Map(collection.sections.map(section => [section.id, section]));
for (const issue of report.issues) {
  const sentence = sections.get(issue.sectionId)?.sentences?.[issue.sentenceNumber - 1];
  if (!sentence) throw new Error(`Audit referenced an unknown entry: ${issue.sectionId}/${issue.sentenceNumber}`);
  if (!issue.replacementText.toLocaleLowerCase('en-US').includes(issue.replacementFocus.toLocaleLowerCase('en-US'))) {
    throw new Error(`Replacement focus is not contiguous: ${issue.sectionId}/${issue.sentenceNumber}`);
  }
}
process.stderr.write(`Audit ${report.verdict}: ${report.issues.length} issue(s)\n`);
