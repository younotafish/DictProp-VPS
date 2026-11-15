// Helpers for the prepare-*-wave scripts. A dispatcher publishes a stage's output in bounded waves: for each wave it
// runs a preparer with the stage's manifest, a cap and the manifest.json of every wave already published, and the
// preparer writes the next wave's manifest.json (and stages its files) under the wave directory.
//
// Each preparer keeps its own cap, which follows the server's limit for that import, and its own rule for when a
// published wave still counts. The two example waves ignore waves published before the sentence source was exported,
// and the saved-sentence wave those published before its analysis manifest was generated, because production may
// have lost them since. The corpus, image and audio waves publish from state kept per input, so every published wave
// counts.
//
// The manifests involved, all `version: 1`:
// - sentence source: { exportedAt, sentences: [{ id, text, sourceWord, sourceSense, textHash, lookupHash,
//   hasAnalysis, hasImage, provenance }] } (a pool record; see sentence-pool.mjs)
// - sentence analyses: { generatedAt, entries: [{ id, textHash, analysis, generatedAt }] }
// - sentence-image bundle: manifest.json { generatedAt, entries: [{ id, textHash, imageFile }] }, with images/
// - item-image bundle: manifest.json { generatedAt, model, entries: [{ parentId, imageId, parentHash, imageFile,
//   promptHash }] }, with images/
// - corpus audit: { generatedAt, model, entries: [{ id, type, sourceHash, wasArchived, archiveForUsage, data }] }
// - audio: { generatedAt, model, aligner, entries: [{ key, voice, text, audioFile, timingsFile, audioSha256,
//   timingsSha256, durationSeconds }] }, with audio/
// A wave's manifest.json keeps its source's entry shape. The dispatchers read the published waves' ids from it and
// the new wave's size from the preparer's one-line summary on stdout.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writePrivateJson } from './offline-io.mjs';

/** A wave's cap: the argument, or `fallback` when it is empty, as an integer from 1 to `max` (when there is one). */
export function parseMaxEntries(raw, { fallback, max }) {
  const value = Number(raw || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new Error(max === undefined
      ? 'max-entries must be a positive integer'
      : `max-entries must be an integer from 1 to ${max}`);
  }
  return value;
}

/**
 * Calls `visit(entry, path)` for each entry of each published wave manifest, in order, after checking the manifest's
 * shape. A manifest generated before `since` is skipped whole. `kind` names the manifest in the error.
 */
export function forEachPublishedEntry(paths, { kind = '', since = -Infinity }, visit) {
  for (const path of paths) {
    const published = readJson(path);
    if (published?.version !== 1 || !Array.isArray(published.entries)) {
      throw new Error(`Published ${kind ? `${kind} ` : ''}manifest is invalid: ${path}`);
    }
    if (Number(published.generatedAt || 0) < since) continue;
    for (const entry of published.entries) visit(entry, path);
  }
}

export function writeWaveManifest(outputDir, manifest) {
  mkdirSync(outputDir, { recursive: true });
  writePrivateJson(join(outputDir, 'manifest.json'), manifest);
}

/** The preparer's summary: one JSON line on stdout, whose waveEntries the dispatcher reads. */
export function printWaveSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
