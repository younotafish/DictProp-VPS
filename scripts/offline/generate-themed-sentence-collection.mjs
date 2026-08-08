#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { installCodexSignalCleanup, killCodex, spawnCodex } from './codex-process.mjs';

const [briefArg, outputArg, workArg] = process.argv.slice(2);
if (!briefArg || !outputArg) {
  throw new Error(
    'Usage: generate-themed-sentence-collection.mjs <brief.json> <collection.json> [work-directory]',
  );
}

const brief = JSON.parse(readFileSync(resolve(briefArg), 'utf8'));
if (brief?.version !== 1 || !brief.collection?.id || !Array.isArray(brief.methodology) ||
    !Array.isArray(brief.sections) || brief.sections.length === 0) {
  throw new Error('The themed-sentence generation brief is invalid');
}

const outputPath = resolve(outputArg);
const workDir = resolve(workArg || join(dirname(outputPath), 'generation-work'));
mkdirSync(workDir, { recursive: true });

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['sectionId', 'sentences'],
  properties: {
    sectionId: { type: 'string', minLength: 1, maxLength: 100 },
    sentences: {
      type: 'array',
      minItems: 18,
      maxItems: 18,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'focus'],
        properties: {
          text: { type: 'string', minLength: 35, maxLength: 280 },
          focus: { type: 'string', minLength: 2, maxLength: 80 },
        },
      },
    },
  },
};
const schemaPath = join(workDir, 'output-schema.json');
writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o600 });

const model = process.env.CODEX_MODEL || 'gpt-5.5';
const concurrency = Math.max(1, Math.min(32, Number(process.env.CODEX_CONCURRENCY || 8)));
const timeoutMinutes = Math.max(5, Math.min(60, Number(process.env.CODEX_TIMEOUT_MINUTES || 30)));
const timeoutMs = timeoutMinutes * 60 * 1_000;
const activeChildren = new Set();
let aborting = false;
installCodexSignalCleanup(activeChildren, () => { aborting = true; });

const normalized = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

function validateSection(value, section) {
  if (value?.sectionId !== section.id || !Array.isArray(value.sentences) || value.sentences.length !== 18) {
    throw new Error(`${section.id}: wrong section identity or sentence count`);
  }
  const seen = new Set();
  for (const [index, sentence] of value.sentences.entries()) {
    const text = String(sentence?.text || '').trim();
    const focus = String(sentence?.focus || '').trim();
    const textKey = normalized(text);
    if (text.length < 35 || text.length > 280 || !/[.!?]$/.test(text)) {
      throw new Error(`${section.id}/${index + 1}: sentence must be a complete, bounded utterance`);
    }
    if (focus.length < 2 || focus.length > 80 || !textKey.includes(normalized(focus))) {
      throw new Error(`${section.id}/${index + 1}: focus must be an exact contiguous source span`);
    }
    if (seen.has(textKey)) throw new Error(`${section.id}/${index + 1}: duplicate sentence`);
    if (/\b(?:mike|mengxi)\s+(?:li|lao li)\b|according to mike|mike (?:says|teaches|recommends)/i.test(text)) {
      throw new Error(`${section.id}/${index + 1}: practice lines must not impersonate or quote the source`);
    }
    seen.add(textKey);
  }
  return value.sentences.map(sentence => ({ text: sentence.text.trim(), focus: sentence.focus.trim() }));
}

function promptFor(section, correction = '') {
  const neighboringSections = brief.sections.map(item => `${item.title}: ${item.description}`).join('\n');
  return `You are designing an advanced American-English memorization collection for a Chinese-speaking professional.

Create exactly 18 ORIGINAL, recitation-ready workplace utterances for this section:
SECTION ID: ${section.id}
TITLE: ${section.title}
PURPOSE: ${section.description}
SPECIFIC GUIDANCE: ${section.guidance}

The collection synthesizes these publicly described executive-communication principles:
${brief.methodology.map(item => `- ${item}`).join('\n')}

The other sections are listed below. Keep this section sharply differentiated and avoid stealing their main scenarios:
${neighboringSections}

Requirements:
- Write natural present-day educated American English at C1-C2 pragmatic difficulty.
- C2 means strategic framing, tact, implication, judgment, and rhetorical control—not ornate or unnatural vocabulary.
- Each line must be something a leader could actually say aloud in a meeting, one-on-one, update, or consequential workplace conversation.
- Vary sentence structures and situations. Include statements, questions, redirects, recommendations, and boundary-setting where appropriate.
- Make the collection broadly useful across industries; do not mention Amazon or any specific employer.
- Do not quote, name, impersonate, or attribute wording to Mike Li. These must be new practice lines inspired only by public high-level ideas.
- Do not write abstract advice, definitions, labels, placeholders, or commentary. Write only usable utterances.
- For every sentence, choose one meaningful B2+ contiguous expression copied EXACTLY from that sentence as focus. It should be worth learning, not an elementary function word.
- Keep each sentence between roughly 8 and 32 words and end it with normal punctuation.
- Return sectionId exactly and exactly 18 unique sentence objects.${correction}`;
}

function runCodex(prompt, resultPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnCodex([
      'exec', '--sandbox', 'read-only', '--ignore-rules', '--skip-git-repo-check',
      '-m', model, '--output-schema', schemaPath, '-o', resultPath, '-',
    ]);
    activeChildren.add(child);
    let stderr = '';
    let hardKill;
    const timeout = setTimeout(() => {
      killCodex(child, 'SIGTERM');
      hardKill = setTimeout(() => killCodex(child, 'SIGKILL'), 10_000);
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.on('error', error => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKill);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      activeChildren.delete(child);
      clearTimeout(timeout);
      clearTimeout(hardKill);
      if (code === 0) resolvePromise();
      else reject(new Error(`Codex exited with ${code ?? signal}: ${stderr}`));
    });
    child.stdin.end(prompt);
  });
}

async function generateSection(section) {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    collection: brief.collection,
    methodology: brief.methodology,
    sections: brief.sections,
    section,
  })).digest('hex').slice(0, 16);
  const resultPath = join(workDir, `${section.id}-${fingerprint}.json`);
  let correction = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!existsSync(resultPath)) await runCodex(promptFor(section, correction), resultPath);
      return validateSection(JSON.parse(readFileSync(resultPath, 'utf8')), section);
    } catch (error) {
      if (aborting || attempt === 2) throw error;
      if (existsSync(resultPath)) unlinkSync(resultPath);
      correction = `\n\nYour previous output failed validation: ${error instanceof Error ? error.message : String(error)}. Return a completely corrected section with all 18 entries.`;
    }
  }
  throw new Error(`${section.id}: exhausted generation retries`);
}

const generatedSections = new Array(brief.sections.length);
let nextSection = 0;
async function worker() {
  for (;;) {
    const index = nextSection++;
    if (index >= brief.sections.length) return;
    const section = brief.sections[index];
    process.stderr.write(`Generating ${section.title} (${index + 1}/${brief.sections.length})\n`);
    generatedSections[index] = await generateSection(section);
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, brief.sections.length) }, () => worker()));
} catch (error) {
  aborting = true;
  for (const child of activeChildren) killCodex(child, 'SIGTERM');
  throw error;
}

const allSentenceKeys = new Set();
for (let sectionIndex = 0; sectionIndex < generatedSections.length; sectionIndex++) {
  for (const sentence of generatedSections[sectionIndex]) {
    const key = normalized(sentence.text);
    if (allSentenceKeys.has(key)) throw new Error(`Cross-section duplicate: ${sentence.text}`);
    allSentenceKeys.add(key);
  }
}

const collection = {
  ...brief.collection,
  sections: brief.sections.map((section, index) => ({
    id: section.id,
    title: section.title,
    description: section.description,
    sentences: generatedSections[index],
  })),
};
const tempPath = `${outputPath}.tmp`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(tempPath, `${JSON.stringify(collection, null, 2)}\n`, { mode: 0o600 });
renameSync(tempPath, outputPath);
process.stderr.write(`Wrote ${allSentenceKeys.size} original sentences to ${outputPath}\n`);
