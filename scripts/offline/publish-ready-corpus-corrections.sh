#!/usr/bin/env bash

set -euo pipefail

READY_MARKER="${1:-data/offline-backfill/example-sentence-pool/corpus-publication-ready}"
BASE_MANIFEST="${2:-data/offline-backfill/final-reconciliation/authoritative-final-corpus-manifest.json}"
TARGET_MANIFEST="${3:-data/offline-backfill/final-reconciliation/usage-adjudicated-corpus-manifest.json}"
BATCH_SIZE="${4:-100}"
REQUIRED_DEPLOY_SHA="${5:-121ecc8}"
PUBLISHED_PREDECESSOR_MANIFEST="${PUBLISHED_CORPUS_PREDECESSOR_MANIFEST:-data/offline-backfill/final-reconciliation/rebased-usage-corrections.json}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-/tmp/dictprop_sentence_bridge_key}"
WORK_ROOT="${CORPUS_REBASE_WORK_ROOT:-data/offline-backfill/final-reconciliation/final-publication}"
STATE_ROOT="${CORPUS_FINAL_WAVE_STATE_ROOT:-/tmp/dictprop-staged-final-corpus-audit}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [[ "$BATCH_SIZE" -lt 1 ]] || [[ "$BATCH_SIZE" -gt 1000 ]]; then
  echo "Corpus correction batch size must be between 1 and 1000" >&2
  exit 2
fi
if [[ ! -x "$GH_BIN" ]]; then
  echo "GitHub CLI is unavailable: $GH_BIN" >&2
  exit 1
fi
if [[ ! -s "$KEY_FILE" ]]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi

log "waiting for verified final corpus metadata"
while [[ ! -s "$READY_MARKER" ]]; do sleep 60; done
for required in "$BASE_MANIFEST" "$TARGET_MANIFEST"; do
  if [[ ! -s "$required" ]]; then
    echo "Required corpus manifest is missing: $required" >&2
    exit 1
  fi
done

mkdir -p "$WORK_ROOT" "$STATE_ROOT"
RUN_ID_FILE="$WORK_ROOT/production-export-run-id"
EXPORT_LOG="$WORK_ROOT/production-export.log"
PRODUCTION_EXPORT="$WORK_ROOT/production-corpus.json"
REBASED_MANIFEST="$WORK_ROOT/rebased-corrections.json"
REBASE_REPORT="$WORK_ROOT/rebase-report.json"
REBASE_ERROR="$WORK_ROOT/rebase-error.log"

rebase_corpus() {
  if [[ -s "$PUBLISHED_PREDECESSOR_MANIFEST" ]]; then
    node scripts/offline/prepare-rebased-corpus-delta.mjs \
      "$PRODUCTION_EXPORT" "$BASE_MANIFEST" "$TARGET_MANIFEST" "$REBASED_MANIFEST" \
      "$PUBLISHED_PREDECESSOR_MANIFEST"
  else
    node scripts/offline/prepare-rebased-corpus-delta.mjs \
      "$PRODUCTION_EXPORT" "$BASE_MANIFEST" "$TARGET_MANIFEST" "$REBASED_MANIFEST"
  fi
}

if [[ ! -s "$PRODUCTION_EXPORT" ]]; then
  if [[ ! -s "$RUN_ID_FILE" ]]; then
    DISPATCHED_AT="$(date -u +%FT%TZ)"
    log "requesting a fresh encrypted production corpus export"
    "$GH_BIN" workflow run sentence-backfill.yml \
      --repo "$REPO" \
      --ref main \
      -f operation=corpus-export

    for _ in $(seq 1 60); do
      while IFS= read -r run_id; do
        [[ -z "$run_id" ]] && continue
        if "$GH_BIN" run view "$run_id" --repo "$REPO" --json jobs \
          --jq '.jobs[] | select(.name == "corpus-export" and (.status == "in_progress" or (.status == "completed" and .conclusion != "skipped"))) | .name' 2>/dev/null \
          | grep -qx 'corpus-export'; then
          printf '%s\n' "$run_id" > "$RUN_ID_FILE"
          break
        fi
      done < <("$GH_BIN" run list \
        --repo "$REPO" \
        --workflow sentence-backfill.yml \
        --event workflow_dispatch \
        --limit 30 \
        --json databaseId,createdAt \
        --jq ".[] | select(.createdAt >= \"$DISPATCHED_AT\") | .databaseId")
      [[ -s "$RUN_ID_FILE" ]] && break
      sleep 5
    done
    if [[ ! -s "$RUN_ID_FILE" ]]; then
      echo "Could not identify the dispatched corpus export workflow" >&2
      exit 1
    fi
  fi

  RUN_ID="$(tr -d '[:space:]' < "$RUN_ID_FILE")"
  log "waiting for production corpus export run $RUN_ID"
  "$GH_BIN" run watch "$RUN_ID" --repo "$REPO" --exit-status
  "$GH_BIN" run view "$RUN_ID" --repo "$REPO" --log > "$EXPORT_LOG"
  node scripts/offline/decrypt-workflow-export.mjs \
    "$EXPORT_LOG" \
    CORPUS_EXPORT \
    "$KEY_FILE" \
    "$PRODUCTION_EXPORT"
fi

log "rebasing verified corrections against the fresh production export"
rm -f "$REBASED_MANIFEST" "$REBASE_REPORT" "$REBASE_ERROR"
if ! rebase_corpus > "$REBASE_REPORT" 2> "$REBASE_ERROR"; then
  if grep -q 'No rebased corpus delta remains to publish' "$REBASE_ERROR"; then
    log "all verified corpus corrections are already live"
    date -u +%FT%TZ > "$STATE_ROOT/complete"
    exit 0
  fi
  cat "$REBASE_ERROR" >&2
  exit 1
fi
cat "$REBASE_REPORT"

REBASING_CONFLICTS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).conflicts)' "$REBASE_REPORT")"
if [[ "$REBASING_CONFLICTS" -ne 0 ]]; then
  echo "Refusing to publish a corpus delta with $REBASING_CONFLICTS conflict(s)" >&2
  exit 1
fi

log "publishing fresh, conflict-free corpus corrections in batches of $BATCH_SIZE"
CORPUS_AUDIT_WAVE_STATE_ROOT="$STATE_ROOT" \
  scripts/offline/dispatch-staged-corpus-audit.sh \
    "$REBASED_MANIFEST" \
    "$BATCH_SIZE" \
    "$REQUIRED_DEPLOY_SHA"
log "verified corpus correction publication complete"
