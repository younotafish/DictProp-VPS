#!/usr/bin/env bash
# The incremental enrichment cycle, which the LaunchAgent com.dictprop.incremental-example-enrichment runs
# from the repository root every six hours. It exports the production corpus, then goes stage by stage:
# vocabulary completion, saved-sentence analyses, saved-item images, then example-sentence analyses and
# images. Each stage publishes what it made, and a later stage builds on it only once production has it.
# Last comes the weekly off-site database backup, when one is due, also when the model or the corpus export failed.
#
# Usage: run-incremental-example-enrichment.sh [cycle-root] [baseline-source.json] [baseline-image-root]
#          [required-deploy-sha]

set -euo pipefail

ROOT="${1:-data/offline-backfill/incremental-example-enrichment}"
# The frozen baseline pool: the July 2026 bulk pipeline built it, and the cycle only adds what came later.
# That pipeline (run-example-sentence-pool-pipeline.sh) was removed on 2026-11-15; see its git history.
BASE_SOURCE="${2:-data/offline-backfill/example-sentence-pool/source.json}"
BASE_IMAGE_ROOT="${3:-data/offline-backfill/example-sentence-pool/final-images}"
BASE_ANALYSIS="${BASE_ANALYSIS:-$(dirname "$BASE_SOURCE")/final-reconciliation/final-analysis.json}"
# Defaults to HEAD, read once the vetted-checkout guard below has run, since the guard can move it.
REQUIRED_DEPLOY_SHA="${4:-}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
NODE_BIN="${NODE_BIN:-node}"
TSX_BIN="${TSX_BIN:-server/node_modules/.bin/tsx}"
ENRICHMENT_MODEL_PROVIDER="${ENRICHMENT_MODEL_PROVIDER:-claude}"
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-opus-5-5}"
CLAUDE_REASONING_EFFORT="${CLAUDE_REASONING_EFFORT:-xhigh}"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-xhigh}"
# Same knob names as the sibling pipelines. The defaults are the scripts' own caps (16 text requests,
# 8 image judgments); the LaunchAgent leaves them unset so a new default applies without a reload. The
# stages read them as CODEX_CONCURRENCY and CODEX_IMAGE_CONCURRENCY, names from when Codex was the only
# provider; they apply to whichever ENRICHMENT_MODEL_PROVIDER runs.
ANALYSIS_CONCURRENCY="${ANALYSIS_CONCURRENCY:-16}"
IMAGE_QA_CONCURRENCY="${IMAGE_QA_CONCURRENCY:-8}"
# An image that fails this many candidates waits for the next cycle, which renders fresh ones; a long
# tail can take dozens of candidates and would hold back every accepted image.
IMAGE_MAX_CANDIDATES="${IMAGE_MAX_CANDIDATES:-8}"
# Local renderer for both image stages. In a side-by-side test on this Mac, Krea-2-Turbo drew the intended
# meaning far more often than ERNIE-Image-Turbo, at about 37 s instead of 8 s per image. A cycle renders
# tens of images, so accuracy outweighs speed.
IMAGE_MODEL="${IMAGE_MODEL:-krea2}"
IMAGE_MODEL_LABEL="${IMAGE_MODEL_LABEL:-krea/Krea-2-Turbo}"
IMAGE_MODEL_QUANTIZE="${IMAGE_MODEL_QUANTIZE:-}"
IMAGE_STEPS="${IMAGE_STEPS:-8}"
# Both image stages render 16:9 candidates at this size, numbered from 1, and judge them in chunks of 64.
readonly IMAGE_WIDTH=1024 IMAGE_HEIGHT=576 IMAGE_FIRST_CANDIDATE=1 IMAGE_CHUNK_SIZE=64
VOCAB_COMPLETION_BATCH_SIZE="${VOCAB_COMPLETION_BATCH_SIZE:-8}"
SENTENCE_ANALYSIS_BATCH_SIZE="${SENTENCE_ANALYSIS_BATCH_SIZE:-4}"
INCREMENTAL_VOCAB_BATCH_SIZE="${INCREMENTAL_VOCAB_BATCH_SIZE:-100}"
INCREMENTAL_VOCAB_LOOKBACK_HOURS="${INCREMENTAL_VOCAB_LOOKBACK_HOURS:-168}"
INCREMENTAL_VOCAB_PROVIDER_FILTER="${INCREMENTAL_VOCAB_PROVIDER_FILTER:-}"
# Every wait below holds the cycle lock, so each one ends. A stage that runs out of time keeps the work
# it finished for the next cycle. The publishers' own limits suit a supervised manual run; a cycle is
# retried six hours later.
TEXT_STAGE_TIMEOUT_SECONDS="${TEXT_STAGE_TIMEOUT_SECONDS:-10800}"
IMAGE_STAGE_TIMEOUT_SECONDS="${IMAGE_STAGE_TIMEOUT_SECONDS:-14400}"
CORPUS_EXPORT_WAIT_SECONDS="${CORPUS_EXPORT_WAIT_SECONDS:-7200}"
export PUBLISH_DEADLINE_SECONDS="${PUBLISH_DEADLINE_SECONDS:-7200}"
export DISPATCH_WAIT_DEADLINE_SECONDS="${DISPATCH_WAIT_DEADLINE_SECONDS:-3600}"
LOCK_FILE="$ROOT/.cycle.lock"
# The LaunchAgent appends each cycle's output to launchd.out.log and launchd.err.log in ROOT.
LAUNCHD_LOG_MAX_BYTES="${LAUNCHD_LOG_MAX_BYTES:-20000000}"
# Items that keep failing a stage wait out a growing backoff here instead of failing every cycle.
FAILURE_LEDGER="$ROOT/failure-ledger.json"
CURRENT_CORPUS="$ROOT/current-corpus.json"
CURRENT_POOL="$ROOT/current-source.json"
SOURCE="$ROOT/source.json"
UNFILTERED_SOURCE="$ROOT/unfiltered-source.json"
ANALYSIS_CACHE="$ROOT/analysis-cache.json"
COMBINED_ANALYSIS_CACHE="$ROOT/combined-analysis-cache.json"
RECONCILIATION="$ROOT/final-reconciliation"
IMAGE_ROOT="$ROOT/final-images"
IMAGE_TARGETS="$IMAGE_ROOT/cycle-targets.json"
# Each stage publishes from a wave-state root of its own per cycle, publish-state/<stage>/<cycle>, where
# <cycle> is CYCLE_ID, the run id of the cycle's corpus export. The example and saved-sentence dispatchers
# also ignore waves published before their input was made, but the vocabulary and item-image dispatchers
# count every wave published in their root, whatever the cycle: for those two, the per-cycle root is all
# that keeps an earlier cycle's waves from counting, so never share it. The image loops keep their working
# state per cycle too, in streaming-quality/<cycle> under each image root.
PUBLISH_STATE_ROOT="$ROOT/publish-state"
SAVED_ROOT="$ROOT/saved-sentences"
SAVED_SOURCE="$SAVED_ROOT/source.json"
SAVED_CYCLE_SOURCE="$SAVED_ROOT/cycle-source.json"
SAVED_BASE_ANALYSIS="$SAVED_ROOT/current-base-analysis.json"
SAVED_ANALYSIS_CACHE="$SAVED_ROOT/analysis-cache.json"
SAVED_RECONCILIATION="$SAVED_ROOT/final-reconciliation"
VOCAB_ROOT="$ROOT/vocabulary"
VOCAB_SOURCE="$VOCAB_ROOT/source.json"
VOCAB_COMPLETED="$VOCAB_ROOT/completed.json"
ITEM_IMAGE_ROOT="$ROOT/item-images"
ITEM_IMAGE_TARGETS="$ITEM_IMAGE_ROOT/cycle-targets.json"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/deadline.sh"
. "$OFFLINE_DIR/vetted-checkout.sh"

case "$ENRICHMENT_MODEL_PROVIDER" in
  claude) MODEL_LABEL="Claude $CLAUDE_MODEL" ;;
  codex) MODEL_LABEL="Codex $CODEX_MODEL" ;;
  *)
    echo "ENRICHMENT_MODEL_PROVIDER must be claude or codex, not $ENRICHMENT_MODEL_PROVIDER" >&2
    exit 1
    ;;
esac
# Every model-calling stage, including the image loop's judge and prompt refiner, inherits this choice.
export ENRICHMENT_MODEL_PROVIDER CLAUDE_MODEL CLAUDE_REASONING_EFFORT CODEX_MODEL CODEX_REASONING_EFFORT
for setting in TEXT_STAGE_TIMEOUT_SECONDS IMAGE_STAGE_TIMEOUT_SECONDS CORPUS_EXPORT_WAIT_SECONDS \
  PUBLISH_DEADLINE_SECONDS DISPATCH_WAIT_DEADLINE_SECONDS LAUNCHD_LOG_MAX_BYTES \
  INCREMENTAL_VOCAB_BATCH_SIZE INCREMENTAL_VOCAB_LOOKBACK_HOURS; do
  if ! [[ "${!setting}" =~ ^[1-9][0-9]*$ ]]; then
    echo "$setting must be a positive integer" >&2
    exit 1
  fi
done

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}
# The publishers inherit the capped deadline, so the cap is logged once per cycle.
cap_publish_deadline

# The slowest request sets a text stage's wall time, so each stage spreads its sentences over every worker:
# one sentence per request until they outnumber the workers, then up to SENTENCE_ANALYSIS_BATCH_SIZE.
sentence_batch_size() {
  local size="$(( ($1 + ANALYSIS_CONCURRENCY - 1) / ANALYSIS_CONCURRENCY ))"
  if [ "$size" -gt "$SENTENCE_ANALYSIS_BATCH_SIZE" ]; then
    size="$SENTENCE_ANALYSIS_BATCH_SIZE"
  fi
  echo "$size"
}

# A stage that fails without crashing lets the rest of the cycle run, and the cycle still exits 1.
FAILED_STAGES=""
stage_failed() {
  FAILED_STAGES="${FAILED_STAGES:+$FAILED_STAGES, }$1"
  log "$1 did not complete this cycle"
}

# What the cycle's closing message says; the example stage, which runs last, sets it.
CYCLE_MESSAGE=""
# How many sentences the running sentence stage works on: those of its source not waiting out a failure backoff.
SENTENCE_COUNT=0
# Ends the cycle with MESSAGE. From the model check on, the cycle ends here unless a step crashes or a signal stops it,
# so the off-site database backup (offsite-backup.sh), when one is due, runs last, once every publisher has finished.
# It needs production to run this cycle's commit, whose server has the backup script, and a failed attempt fails the
# cycle.
finish_cycle() {
  log "$1"
  if ! GH_BIN="$GH_BIN" NODE_BIN="$NODE_BIN" SENTENCE_BRIDGE_KEY_FILE="$KEY_FILE" GITHUB_REPOSITORY="$REPO" \
    bash scripts/offline/offsite-backup.sh "$REQUIRED_DEPLOY_SHA"; then
    stage_failed "off-site backup"
  fi
  "$NODE_BIN" scripts/offline/failure-ledger.mjs summary "$FAILURE_LEDGER" || true
  if [ -n "$FAILED_STAGES" ]; then
    log "stages that did not complete this cycle: $FAILED_STAGES"
    exit 1
  fi
  exit 0
}

# Every later stage needs the model, so a model that stopped answering ends the cycle.
require_model() {
  if ! "$NODE_BIN" scripts/offline/check-structured-model.mjs; then
    finish_cycle "local $MODEL_LABEL stopped answering; ending this cycle"
  fi
}

# Text stages exit 3 when no item succeeded and 124 when they ran out of time; items that failed are in
# the failure ledger. Any other status is a crash and ends the cycle as before.
check_stage() {
  case "$2" in
    0) return 0 ;;
    3|124)
      stage_failed "$1"
      require_model
      return 1
      ;;
    *) exit "$2" ;;
  esac
}

# json_value FILE EXPRESSION: prints EXPRESSION of the JSON document in FILE, as in `json_value report.json
# .missing`.
json_value() {
  "$NODE_BIN" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1]))$2)" "$1"
}

# ensure_analysis_cache FILE: starts FILE as an empty analysis manifest unless it holds one.
ensure_analysis_cache() {
  if [ ! -s "$1" ]; then
    "$NODE_BIN" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({version:1,generatedAt:Date.now(),entries:[]},null,2)+"\n", {mode:0o600})' \
      "$1"
  fi
}

# run_image_stage LEDGER_STAGE TARGETS ROOT STAGE: renders TARGETS with the image loop within the image stage's
# time, keeping its candidates, the accepted images and this cycle's working state under ROOT, and records each
# target's outcome in the failure ledger, so images deferred after too many rejected candidates stop being
# rendered every cycle. A loop that failed fails STAGE, and the model must still answer.
run_image_stage() {
  local ledger_stage="$1" targets="$2" root="$3" stage="$4" status=0
  run_stage "$IMAGE_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" \
    CODEX_IMAGE_CONCURRENCY="$IMAGE_QA_CONCURRENCY" IMAGE_MODEL="$IMAGE_MODEL" IMAGE_MODEL_QUANTIZE="$IMAGE_MODEL_QUANTIZE" \
    IMAGE_QUALITY_DEFER_AFTER="$IMAGE_MAX_CANDIDATES" \
    bash scripts/offline/run-streaming-image-quality-loop.sh \
      "$targets" "$root/candidates" "$root/images" "$root/streaming-quality/$CYCLE_ID" \
      "$IMAGE_WIDTH" "$IMAGE_HEIGHT" "$IMAGE_STEPS" "$IMAGE_FIRST_CANDIDATE" "$IMAGE_CHUNK_SIZE" || status=$?
  "$NODE_BIN" scripts/offline/failure-ledger.mjs record-image-outcomes \
    "$FAILURE_LEDGER" "$ledger_stage" "$targets" "$root/images" "$status"
  if [ "$status" -ne 0 ]; then
    stage_failed "$stage"
    require_model
  fi
}

# filter_sentences LEDGER_STAGE SOURCE CYCLE_SOURCE: writes to CYCLE_SOURCE the sentences of SOURCE that are not
# waiting out a failure backoff in LEDGER_STAGE, and sets SENTENCE_COUNT to their number.
filter_sentences() {
  SENTENCE_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-sentences "$FAILURE_LEDGER" "$1" "$2" "$3")"
}

# analyze_and_reconcile NOUN LEDGER_STAGE SOURCE CYCLE_SOURCE ANALYSES RECONCILIATION WORK_ROOT BASE [ALLOW_BASIC]:
# the analysis half of a sentence stage. It reconciles CYCLE_SOURCE, which filter_sentences made from SOURCE, with
# the analysis manifest ANALYSES into RECONCILIATION. When some sentences lack an analysis, the model writes theirs
# under WORK_ROOT, keeping grammar from BASE and recording failures under LEDGER_STAGE; then the sentences that
# just failed wait out their backoff, so SOURCE is filtered again and the rest are reconciled with the new
# analyses. NOUN names the missing sentences in the log, and ALLOW_BASIC=1 lets reconciliation keep a basic
# analysis production already covers. The caller checks SENTENCE_COUNT and RECONCILIATION afterwards.
analyze_and_reconcile() {
  local noun="$1" ledger_stage="$2" source="$3" cycle_source="$4" analyses="$5" reconciliation="$6"
  local work_root="$7" base="$8" new_analysis="$7/new-analysis.json" missing status=0
  local reconcile=("$NODE_BIN" scripts/offline/reconcile-sentence-analyses.mjs "$cycle_source" "$analyses" "$reconciliation")
  if [ "${9:-}" = 1 ]; then reconcile=(env ALLOW_PRODUCTION_COVERED_BASIC_ANALYSIS=1 "${reconcile[@]}"); fi
  # Reconciliation writes final-analysis.json only when it is complete and never removes an old one.
  rm -f "$reconciliation/final-analysis.json"
  "${reconcile[@]}"
  missing="$(json_value "$reconciliation/report.json" .missing)"
  if [ "$missing" -eq 0 ]; then return 0; fi
  log "generating detailed $MODEL_LABEL explanations for $missing $noun"
  rm -f "$new_analysis"
  run_stage "$TEXT_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" SENTENCE_ANALYSIS_BATCH_SIZE="$(sentence_batch_size "$missing")" \
    ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE="$ledger_stage" \
    "$NODE_BIN" scripts/offline/enrich-sentences.mjs \
      "$reconciliation/missing-source.json" "$new_analysis" "$work_root/analysis-work" "$base" || status=$?
  check_stage "$ledger_stage analysis" "$status" || true
  # Sentences that just failed now wait out their backoff, so the rest can still be published.
  filter_sentences "$ledger_stage" "$source" "$cycle_source"
  if [ "$SENTENCE_COUNT" -eq 0 ]; then return 0; fi
  if [ -s "$new_analysis" ]; then
    "${reconcile[@]}" "$new_analysis" || true
  else
    "${reconcile[@]}"
  fi
}

# image_pipeline_busy STAGE: true, after logging it, when another local image pipeline is running. One
# image job saturates the GPU, so the image stage STAGE leaves its new images to a later cycle and
# publishes only the ones accepted before.
image_pipeline_busy() {
  local pids
  pids="$(pgrep -f '[r]un-streaming-image-quality-loop\.sh' | tr '\n' ' ' || true)"
  if [ -z "$pids" ]; then return 1; fi
  log "another local image pipeline is active (pid ${pids% }); $1 wait for a later cycle"
}

# The corpus export failed, as MESSAGE says. With no corpus to work on, the cycle skips its stages, and finish_cycle
# still runs the off-site backup.
corpus_export_failed() {
  echo "$1" >&2
  stage_failed "corpus export"
  finish_cycle "no production corpus to work on; ending this cycle"
}

# Has the sentence-backfill workflow export the production corpus and waits for that run, EXPORT_RUN_ID, to end;
# EXPORT_CONCLUSION says how it ended. A run it can't dispatch or find, or one that doesn't finish in time, ends the
# cycle.
run_corpus_export() {
  PREVIOUS_RUN_ID="$(gh_bounded run list \
    --repo "$REPO" --workflow sentence-backfill.yml --event workflow_dispatch --limit 1 \
    --json databaseId --jq 'if length == 0 then 0 else .[0].databaseId end')" \
    || corpus_export_failed "Could not list the runs of the corpus export workflow"
  if ! [[ "$PREVIOUS_RUN_ID" =~ ^[0-9]+$ ]]; then PREVIOUS_RUN_ID=0; fi
  # Only runs created after this dispatch qualify, so an older queued export is never taken for this one.
  EXPORT_SINCE="$(utc_timestamp_ago 120)"
  log "requesting a fresh encrypted production corpus export"
  gh_bounded workflow run sentence-backfill.yml --repo "$REPO" --ref main -f operation=corpus-export \
    || corpus_export_failed "Could not dispatch the corpus export workflow"

  EXPORT_RUN_ID=""
  DISCOVERY_DEADLINE="$(deadline_after 600)"
  until [ -n "$EXPORT_RUN_ID" ] || deadline_passed "$DISCOVERY_DEADLINE"; do
    sleep 5
    while IFS= read -r candidate; do
      if gh_bounded run view "$candidate" --repo "$REPO" --json jobs \
        --jq '.jobs[] | select(.name == "corpus-export" and .conclusion != "skipped") | .name' 2>/dev/null \
        | grep -qx corpus-export; then
        EXPORT_RUN_ID="$candidate"
        break
      fi
    done < <(gh_bounded run list \
      --repo "$REPO" --workflow sentence-backfill.yml --event workflow_dispatch --limit 30 \
      --json databaseId,createdAt \
      --jq ".[] | select(.databaseId > $PREVIOUS_RUN_ID and .createdAt >= \"$EXPORT_SINCE\") | .databaseId" \
      2>/dev/null | sort -n)
  done
  if [ -z "$EXPORT_RUN_ID" ]; then
    corpus_export_failed "Could not identify the dispatched corpus export workflow"
  fi

  log "waiting for corpus export run $EXPORT_RUN_ID"
  EXPORT_DEADLINE="$(deadline_after "$CORPUS_EXPORT_WAIT_SECONDS")"
  while :; do
    EXPORT_STATE="$(gh_bounded run view "$EXPORT_RUN_ID" --repo "$REPO" --json status,conclusion \
      --jq '[.status, .conclusion] | @tsv' 2>/dev/null || true)"
    IFS=$'\t' read -r EXPORT_STATUS EXPORT_CONCLUSION <<< "$EXPORT_STATE"
    if [ "$EXPORT_STATUS" = completed ]; then return 0; fi
    if deadline_passed "$EXPORT_DEADLINE"; then
      corpus_export_failed "Corpus export run $EXPORT_RUN_ID did not finish within ${CORPUS_EXPORT_WAIT_SECONDS}s"
    fi
    sleep 10
  done
}

# Exports the production corpus into CURRENT_CORPUS. A deploy's container swap can end an export mid-query, and a
# newer job in its queue cancels one still waiting, so a run that ends any way but success gets one more. The
# successful run's id names the cycle: CYCLE_ID. The run's conclusion is read from a variable rather than
# run_corpus_export's status, since calling it in a condition would turn set -e off inside it.
export_corpus() {
  run_corpus_export
  if [ "$EXPORT_CONCLUSION" != success ]; then
    log "corpus export run $EXPORT_RUN_ID ended as $EXPORT_CONCLUSION; requesting one more export"
    run_corpus_export
  fi
  if [ "$EXPORT_CONCLUSION" != success ]; then
    corpus_export_failed "Corpus export run $EXPORT_RUN_ID ended as $EXPORT_CONCLUSION"
  fi
  CYCLE_ID="$EXPORT_RUN_ID"
  # The run left the corpus as an encrypted artifact; fetching it deletes the artifact and the run's log.
  GH_BIN="$GH_BIN" NODE_BIN="$NODE_BIN" SENTENCE_BRIDGE_KEY_FILE="$KEY_FILE" GITHUB_REPOSITORY="$REPO" \
    scripts/offline/fetch-workflow-export.sh "$EXPORT_RUN_ID" corpus-export "$CURRENT_CORPUS" \
    || corpus_export_failed "Could not fetch the corpus export of run $EXPORT_RUN_ID"
}

# Completes new or incomplete vocabulary records and publishes them. VOCAB_OVERLAY is the completed records
# once production has them, for the later stages to build on, and - otherwise.
stage_vocabulary() {
  mkdir -p "$VOCAB_ROOT"
  ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE=vocab \
  "$NODE_BIN" scripts/offline/prepare-incremental-vocab-source.mjs \
    "$CURRENT_CORPUS" "$VOCAB_SOURCE.tmp" "$INCREMENTAL_VOCAB_BATCH_SIZE" "$INCREMENTAL_VOCAB_LOOKBACK_HOURS" \
    "$INCREMENTAL_VOCAB_PROVIDER_FILTER"
  mv "$VOCAB_SOURCE.tmp" "$VOCAB_SOURCE"
  VOCAB_COUNT="$(json_value "$VOCAB_SOURCE" .entries.length)"
  VOCAB_OVERLAY="-"
  if [ "$VOCAB_COUNT" -gt 0 ]; then
    log "creating advanced $MODEL_LABEL metadata for $VOCAB_COUNT new or incomplete vocabulary record(s)"
    rm -f "$VOCAB_COMPLETED"
    STAGE_STATUS=0
    run_stage "$TEXT_STAGE_TIMEOUT_SECONDS" env CODEX_CONCURRENCY="$ANALYSIS_CONCURRENCY" \
      VOCAB_COMPLETION_BATCH_SIZE="$VOCAB_COMPLETION_BATCH_SIZE" \
      ENRICHMENT_FAILURE_LEDGER="$FAILURE_LEDGER" ENRICHMENT_FAILURE_STAGE=vocab \
      "$NODE_BIN" scripts/offline/complete-corpus-fields.mjs \
        "$VOCAB_SOURCE" "$VOCAB_COMPLETED" "$VOCAB_ROOT/work" || STAGE_STATUS=$?
    if check_stage "vocabulary completion" "$STAGE_STATUS"; then
      log "publishing locally completed vocabulary records"
      # Later stages build on the completed records only once production has them.
      if CORPUS_AUDIT_WAVE_STATE_ROOT="$PUBLISH_STATE_ROOT/vocabulary/$CYCLE_ID" \
        CORPUS_AUDIT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
        scripts/offline/dispatch-staged-corpus-audit.sh \
          "$VOCAB_COMPLETED" 100 "$REQUIRED_DEPLOY_SHA"; then
        VOCAB_OVERLAY="$VOCAB_COMPLETED"
      else
        stage_failed "vocabulary publication"
      fi
    fi
  else
    log "no recent vocabulary records need structural completion"
  fi
}

# Gives the saved sentences that lack one a detailed analysis, and publishes the analyses.
stage_saved_sentences() {
  mkdir -p "$SAVED_ROOT"
  SAVED_PREVIOUS_SOURCE="-"
  if [ -s "$SAVED_SOURCE" ]; then SAVED_PREVIOUS_SOURCE="$SAVED_SOURCE"; fi
  "$TSX_BIN" server/src/scripts/prepare-incremental-saved-sentence-source.ts \
    "$CURRENT_CORPUS" "$SAVED_SOURCE.tmp" "$SAVED_PREVIOUS_SOURCE" "$SAVED_BASE_ANALYSIS"
  mv "$SAVED_SOURCE.tmp" "$SAVED_SOURCE"
  # The source keeps every sentence, so the next cycle still sees each one's first identity; this cycle
  # works on those that are not waiting out a failure backoff.
  filter_sentences saved-sentence "$SAVED_SOURCE" "$SAVED_CYCLE_SOURCE"
  if [ "$SENTENCE_COUNT" -gt 0 ]; then
    ensure_analysis_cache "$SAVED_ANALYSIS_CACHE"
    analyze_and_reconcile "saved sentence(s)" saved-sentence "$SAVED_SOURCE" "$SAVED_CYCLE_SOURCE" \
      "$SAVED_ANALYSIS_CACHE" "$SAVED_RECONCILIATION" "$SAVED_ROOT" "$SAVED_BASE_ANALYSIS"
    if [ -s "$SAVED_RECONCILIATION/final-analysis.json" ]; then
      cp "$SAVED_RECONCILIATION/final-analysis.json" "$SAVED_ANALYSIS_CACHE.tmp"
      mv "$SAVED_ANALYSIS_CACHE.tmp" "$SAVED_ANALYSIS_CACHE"
      log "publishing detailed saved-sentence analyses"
      if ! REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 \
        SAVED_SENTENCE_ANALYSIS_STATE_ROOT="$PUBLISH_STATE_ROOT/saved-sentences/$CYCLE_ID" \
        SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
        scripts/offline/dispatch-staged-saved-sentence-analyses.sh \
          "$SAVED_ANALYSIS_CACHE" 2000 "$REQUIRED_DEPLOY_SHA"; then
        stage_failed "saved-sentence publication"
      fi
    elif [ "$SENTENCE_COUNT" -gt 0 ]; then
      echo "Incremental saved-sentence analysis reconciliation is incomplete" >&2
      stage_failed "saved-sentence reconciliation"
    fi
  else
    log "no saved sentences need detailed analysis"
  fi
}

# Renders the missing images of saved words, phrases and sentences, has the model judge them, and publishes
# the accepted ones.
stage_item_images() {
  mkdir -p "$ITEM_IMAGE_ROOT"
  SAVED_ANALYSIS_INPUT="-"
  if [ -s "$SAVED_ANALYSIS_CACHE" ]; then SAVED_ANALYSIS_INPUT="$SAVED_ANALYSIS_CACHE"; fi
  "$NODE_BIN" scripts/offline/prepare-incremental-item-images.mjs \
    "$CURRENT_CORPUS" \
    "$SAVED_ANALYSIS_INPUT" \
    "$VOCAB_OVERLAY" \
    "$ITEM_IMAGE_ROOT" \
    "$IMAGE_MODEL_LABEL"
  ITEM_IMAGE_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-image-targets \
    "$FAILURE_LEDGER" item-image "$ITEM_IMAGE_ROOT/targets.json" "$ITEM_IMAGE_TARGETS")"
  if [ "$ITEM_IMAGE_COUNT" -gt 0 ]; then
    if ! image_pipeline_busy "saved-item images"; then
      log "generating locally and judging with $MODEL_LABEL $ITEM_IMAGE_COUNT missing saved-word/phrase/sentence image(s)"
      run_image_stage item-image "$ITEM_IMAGE_TARGETS" "$ITEM_IMAGE_ROOT" "saved-item images"
    fi
    # The publisher waits for every manifest entry, so the images the loop didn't accept leave the manifest;
    # a later cycle targets them again.
    ITEM_IMAGE_READY="$("$NODE_BIN" scripts/offline/prepare-incremental-item-images.mjs prune-missing "$ITEM_IMAGE_ROOT")"
    if [ "$ITEM_IMAGE_READY" -gt 0 ]; then
      log "publishing $ITEM_IMAGE_READY locally generated saved-word/phrase/sentence image(s)"
      if ! OFFLINE_IMAGE_WAVE_STATE_ROOT="$PUBLISH_STATE_ROOT/item-images/$CYCLE_ID" \
        OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
        scripts/offline/dispatch-staged-offline-images.sh \
          "$ITEM_IMAGE_ROOT" 100 "$REQUIRED_DEPLOY_SHA"; then
        stage_failed "saved-item image publication"
      fi
    fi
  else
    log "no saved-word/phrase/sentence image needs generating this cycle"
  fi
}

# Builds the cycle's example-sentence source, gives the sentences production lacks one for a detailed
# analysis, and publishes the analyses ahead of their images, which follow. When nothing is left to
# publish, the stage returns early, and CYCLE_MESSAGE says why.
stage_example_sentences() {
  "$NODE_BIN" scripts/offline/build-example-sentence-pool.mjs \
    "$CURRENT_CORPUS" "$CURRENT_POOL.tmp" "$VOCAB_OVERLAY"
  mv "$CURRENT_POOL.tmp" "$CURRENT_POOL"
  # The unfiltered source carries each sentence's first identity to the next cycle. source.json, which the
  # verifier and the publishers read, leaves out sentences waiting out a failure backoff.
  PREVIOUS_SOURCE="-"
  if [ -s "$UNFILTERED_SOURCE" ]; then PREVIOUS_SOURCE="$UNFILTERED_SOURCE"; fi
  "$NODE_BIN" scripts/offline/prepare-incremental-example-source.mjs \
    "$CURRENT_POOL" "$BASE_SOURCE" "$SOURCE.tmp" "$PREVIOUS_SOURCE"
  mv "$SOURCE.tmp" "$UNFILTERED_SOURCE"

  filter_sentences example-sentence "$UNFILTERED_SOURCE" "$SOURCE"
  if [ "$SENTENCE_COUNT" -eq 0 ]; then
    CYCLE_MESSAGE="no post-baseline example sentences need enrichment"
    return 0
  fi

  ensure_analysis_cache "$ANALYSIS_CACHE"
  "$NODE_BIN" scripts/offline/merge-sentence-analysis-manifests.mjs \
    "$COMBINED_ANALYSIS_CACHE" "$BASE_ANALYSIS" "$ANALYSIS_CACHE"
  analyze_and_reconcile "production gap(s)" example-sentence "$UNFILTERED_SOURCE" "$SOURCE" \
    "$COMBINED_ANALYSIS_CACHE" "$RECONCILIATION" "$ROOT" "$ANALYSIS_CACHE" 1
  if [ "$SENTENCE_COUNT" -eq 0 ]; then
    CYCLE_MESSAGE="every post-baseline example sentence is waiting out a failure backoff"
    return 0
  fi
  if [ ! -s "$RECONCILIATION/final-analysis.json" ]; then
    echo "Incremental sentence analysis reconciliation is incomplete" >&2
    stage_failed "example-sentence reconciliation"
    CYCLE_MESSAGE="example sentences are not published this cycle"
    return 0
  fi
  "$NODE_BIN" scripts/offline/merge-sentence-analysis-manifests.mjs \
    "$ANALYSIS_CACHE.next" "$ANALYSIS_CACHE" "$RECONCILIATION/final-analysis.json"
  mv "$ANALYSIS_CACHE.next" "$ANALYSIS_CACHE"
  "$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
    "$SOURCE" "$RECONCILIATION/final-analysis.json"
  log "publishing validated explanations before their images"
  if ! REQUIRE_DETAILED_SENTENCE_ANALYSIS=1 \
    EXAMPLE_ANALYSIS_WAVE_STATE_ROOT="$PUBLISH_STATE_ROOT/example-analyses/$CYCLE_ID" \
    EXAMPLE_ANALYSIS_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
    scripts/offline/dispatch-staged-example-analyses.sh "$ROOT" 2000 "$REQUIRED_DEPLOY_SHA"; then
    stage_failed "example-sentence analysis publication"
  fi

  example_images
}

# The rest of the example stage: renders the missing example images, has the model judge them, and
# publishes the accepted ones with their analyses.
example_images() {
  "$NODE_BIN" scripts/offline/prepare-sentence-images.mjs \
    "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT" "$IMAGE_MODEL_LABEL" \
    "$BASE_IMAGE_ROOT/images"
  IMAGE_TARGET_COUNT="$("$NODE_BIN" scripts/offline/failure-ledger.mjs filter-image-targets \
    "$FAILURE_LEDGER" example-image "$IMAGE_ROOT/targets.json" "$IMAGE_TARGETS")"

  if [ "$IMAGE_TARGET_COUNT" -gt 0 ]; then
    if ! image_pipeline_busy "example images"; then
      log "generating $IMAGE_TARGET_COUNT missing example image(s) locally and judging them with $MODEL_LABEL"
      run_image_stage example-image "$IMAGE_TARGETS" "$IMAGE_ROOT" "example images"
    fi
  else
    log "no example image needs generating this cycle"
  fi

  # Explanations are already published, so a deferred image only delays its own sentence's image.
  ALLOW_DEFERRED_IMAGES=1 \
  "$NODE_BIN" scripts/offline/verify-example-sentence-pool.mjs \
    "$SOURCE" "$RECONCILIATION/final-analysis.json" "$IMAGE_ROOT"
  log "publishing verified incremental explanation-image pairs"
  if ! ALLOW_DEFERRED_IMAGES=1 \
    EXAMPLE_ENRICHMENT_WAVE_STATE_ROOT="$PUBLISH_STATE_ROOT/example-enrichments/$CYCLE_ID" \
    EXAMPLE_ENRICHMENT_WAVE_COOLDOWN_SECONDS=30 GH_BIN="$GH_BIN" \
    scripts/offline/dispatch-staged-example-enrichments.sh "$ROOT" 100 "$REQUIRED_DEPLOY_SHA"; then
    stage_failed "example enrichment publication"
  fi
  CYCLE_MESSAGE="incremental example-enrichment cycle complete: $SENTENCE_COUNT post-baseline sentence(s)"
}

mkdir -p "$ROOT"
if ! shlock -f "$LOCK_FILE" -p "$$"; then
  log "another incremental enrichment cycle is already running"
  exit 0
fi
cleanup() {
  stop_stage
  rm -f "$LOCK_FILE"
}
# A signal has to end the cycle; cleaning up and carrying on would run the rest without the lock.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Nothing else trims the LaunchAgent's logs, so one past LAUNCHD_LOG_MAX_BYTES becomes <log>.1, replacing
# the one before. This cycle goes on writing to the renamed file, and the next launch starts a fresh log.
for launchd_log in "$ROOT/launchd.out.log" "$ROOT/launchd.err.log"; do
  if [ -f "$launchd_log" ] && [ "$(wc -c < "$launchd_log" | tr -d ' ')" -gt "$LAUNCHD_LOG_MAX_BYTES" ]; then
    mv -f "$launchd_log" "$launchd_log.1"
  fi
done

# 75 (EX_TEMPFAIL) marks a cycle that stopped before starting in the LaunchAgent log; the next cycle checks
# again, and after a fast-forward that changed this code, it runs the new code.
VETTED_STATUS=0
require_vetted_checkout || VETTED_STATUS=$?
case "$VETTED_STATUS" in
  0) ;;
  2)
    log "the fast-forward changed code the cycle runs; exiting 75 so the next cycle runs the new code"
    exit 75
    ;;
  *)
    # Every refusal in require_vetted_checkout, whether over the code or its packages, logs its reason first.
    log "refusing to run this cycle (the reason is logged above); exiting 75"
    exit 75
    ;;
esac
# The publishers wait for this commit's deployment, and HEAD is vps/main now that the guard passed.
REQUIRED_DEPLOY_SHA="${REQUIRED_DEPLOY_SHA:-$(git rev-parse HEAD)}"

ACTIVE_TEXT_JOBS="$(pgrep -f '[n]ode scripts/offline/(enrich-sentences|complete-corpus-fields)\.mjs' | tr '\n' ' ' || true)"
if [ -n "$ACTIVE_TEXT_JOBS" ]; then
  log "another local sentence-analysis job is active (pid ${ACTIVE_TEXT_JOBS% }); deferring this cycle"
  exit 0
fi

# Git doesn't track the GitHub CLI, so only this check notices it gone. An empty file is refused too: the
# shell would run it as an empty script, and every gh call would succeed with no output.
if [ ! -s "$GH_BIN" ] || [ ! -x "$GH_BIN" ]; then
  echo "Required incremental enrichment input is missing: $GH_BIN (a non-empty, executable GitHub CLI; scripts/offline/README.md's Setup says how to install it)" >&2
  exit 1
fi
for required in "$KEY_FILE" "$BASE_SOURCE" "$BASE_ANALYSIS" "$TSX_BIN"; do
  if [ ! -s "$required" ]; then
    echo "Required incremental enrichment input is missing: $required" >&2
    exit 1
  fi
done
# The example image stage links in the images the baseline already accepted, from its images/ folder.
if [ ! -d "$BASE_IMAGE_ROOT/images" ]; then
  echo "Required incremental enrichment input is missing: $BASE_IMAGE_ROOT/images" >&2
  exit 1
fi

# A publisher that was killed leaves its release, and the encrypted archive in it, on the public
# repository; this deletes publisher releases idle for six hours, which none of this cycle's publishers
# would still hold, clears past cycles' directories and failed waves once idle for a week, and removes
# published waves' archives. No cycle opens a past cycle's directory again, so a wave one left unpublished
# there counts as failed. It also removes the temp files a killed encryption or decryption leaves under
# data/offline-backfill once a day old, a decryption's with plaintext in them.
# After the stages' roots come the image loops' working roots, whose past cycles' directories go the same way,
# and then the five roots cycles used until 2026-11-15, still swept for what they hold.
if ! GH_BIN="$GH_BIN" NODE_BIN="$NODE_BIN" GITHUB_REPOSITORY="$REPO" scripts/offline/sweep-bridge-leftovers.sh \
  "$PUBLISH_STATE_ROOT/vocabulary" "$PUBLISH_STATE_ROOT/saved-sentences" "$PUBLISH_STATE_ROOT/item-images" \
  "$PUBLISH_STATE_ROOT/example-analyses" "$PUBLISH_STATE_ROOT/example-enrichments" \
  "$ITEM_IMAGE_ROOT/streaming-quality" "$IMAGE_ROOT/streaming-quality" \
  "$ROOT/publish-state-coverage-v2" "$ROOT/analysis-publish-state-coverage-v2" \
  "$SAVED_ROOT/publish-state-detailed-v1" "$VOCAB_ROOT/publish-state" "$ITEM_IMAGE_ROOT/publish-state"; then
  log "the sweep of bridge leftovers did not finish; the next cycle tries again"
fi

log "checking that local $MODEL_LABEL can answer before exporting production data"
if ! "$NODE_BIN" scripts/offline/check-structured-model.mjs; then
  stage_failed "model check"
  finish_cycle "local $MODEL_LABEL can't answer; ending this cycle before it exports anything"
fi

export_corpus
stage_vocabulary
stage_saved_sentences
stage_item_images
# The example sentences go last, since the stage returns early when it has nothing left to publish.
stage_example_sentences
finish_cycle "$CYCLE_MESSAGE"
