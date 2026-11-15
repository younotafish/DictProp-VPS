// The image judge's and the prompt refiner's own logic: the records each sends, and how each reads the
// model's answer. judge-image-candidates.mjs and refine-rejected-image-prompts.mjs run it.

import { join } from 'node:path';
import { indexedResults } from './model-stage.mjs';

const DEFAULT_REJECTION_REASON = 'The previous image did not communicate the exact meaning clearly enough.';

// Candidate n of an image is its filename with -n before the extension, in the candidate directory.
export function candidateFile(candidateDir, filename, candidateNumber) {
  return join(candidateDir, filename.replace(/(\.[^.]+)$/, `-${candidateNumber}$1`));
}

export function judgmentRecords(batch, candidateNumber) {
  return batch.map((target, itemIndex) => ({
    itemIndex,
    candidateNumber,
    learningTarget: target.learningTarget,
    brief: target.prompt,
  }));
}

// One batch's verdicts, in target order: { target, result, candidate } with result.acceptable a boolean.
export function readVerdicts(parsed, batch, candidates, batchNumber) {
  const byIndex = indexedResults(parsed, batch.length, {
    wrongCount: `Batch ${batchNumber} returned the wrong result count`,
    duplicate: `Batch ${batchNumber} returned duplicate indexes`,
  });
  return batch.map((target, itemIndex) => {
    const result = byIndex.get(itemIndex);
    if (!result || typeof result.acceptable !== 'boolean') throw new Error(`Batch ${batchNumber} omitted index ${itemIndex}`);
    return { target, result, candidate: candidates[itemIndex] };
  });
}

export function refinementRecords(batch) {
  return batch.map((target, itemIndex) => ({
    itemIndex,
    learningTarget: target.learningTarget,
    rejectedBrief: target.prompt,
    rejectionReason: target.rejectionReason || DEFAULT_REJECTION_REASON,
  }));
}

// One batch's refined targets, in order. Each keeps the brief it started from as originalPrompt.
export function readRefinements(parsed, batch, batchNumber) {
  const byIndex = indexedResults(parsed, batch.length, {
    wrongCount: `Batch ${batchNumber} returned the wrong result count`,
    duplicate: `Batch ${batchNumber} returned duplicate indexes`,
  });
  return batch.map((target, itemIndex) => {
    const result = byIndex.get(itemIndex);
    if (!result || typeof result.prompt !== 'string' || result.prompt.trim().length < 40 ||
        typeof result.change !== 'string') {
      throw new Error(`Batch ${batchNumber} omitted index ${itemIndex}`);
    }
    return {
      ...target,
      originalPrompt: target.originalPrompt || target.prompt,
      prompt: result.prompt.trim(),
      promptRefinement: result.change.trim(),
    };
  });
}
