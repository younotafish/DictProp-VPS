#!/usr/bin/env bash
# Publishes one encrypted bridge archive to production: uploads it to its release, waits until the commit
# the import needs is deployed, dispatches the import, follows that exact run to success and a healthy
# production, then deletes the release. No wait outlasts PUBLISH_DEADLINE_SECONDS: at the deadline the
# release is deleted and STATE_DIR/failed written, so the dispatcher sets the wave aside.
#
# Only STATE_DIR/complete and STATE_DIR/failed outlive this process. Every caller encrypts a fresh archive,
# with a new salt and IV, before calling, so nothing a stopped publisher had in flight could be resumed.

set -uo pipefail

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
  echo "Usage: $0 <release-tag> <encrypted-archive> <asset-name> <operation> <required-deploy-sha> [poll-seconds]" >&2
  exit 2
fi

RELEASE_TAG="$1"
ARCHIVE="$2"
ASSET_NAME="$3"
OPERATION="$4"
POLL_SECONDS="${6:-300}"
STATE_KEY="$(printf '%s' "$RELEASE_TAG" | tr -c 'A-Za-z0-9._-' '_')"
# The dispatchers keep this state beside their wave, so setting a failed wave aside also discards it.
STATE_DIR="${PUBLISH_STATE_DIR:-${TMPDIR:-/tmp}/dictprop-publish-${STATE_KEY}}"
PUBLISH_DEADLINE_SECONDS="${PUBLISH_DEADLINE_SECONDS:-14400}"
CLOCK_SKEW_SECONDS=120
NODE_BIN="${NODE_BIN:-node}"

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deadline.sh"

# GitHub matches a deployment by its full head SHA, so the commit must resolve here or be given in full.
if ! DEPLOY_SHA="$(git rev-parse --verify --quiet "$5^{commit}" 2>/dev/null)"; then
  if [[ "$5" =~ ^[0-9a-f]{40}$ ]]; then
    DEPLOY_SHA="$5"
  else
    echo "required-deploy-sha must be a commit this checkout knows or a full 40-character SHA: $5" >&2
    exit 2
  fi
fi
case "$OPERATION" in
  import|corpus-import|image-import|enrichment-import|audio-import|essay-import)
    IMPORT_JOB="$OPERATION"
    ;;
  *)
    echo "Unsupported bridge import operation: $OPERATION" >&2
    exit 2
    ;;
esac
if ! [[ "$PUBLISH_DEADLINE_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PUBLISH_DEADLINE_SECONDS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$POLL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "poll-seconds must be a non-negative integer: $POLL_SECONDS" >&2
  exit 2
fi

mkdir -p "$STATE_DIR"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}
cap_publish_deadline

# Prints "<API Requests>|<Actions>" with each component's status on githubstatus.com, or unknown for one the
# page doesn't give, on exactly one line.
component_states() {
  local body states
  body="$(curl -fsSL --connect-timeout 10 --max-time 30 --retry 2 \
    https://www.githubstatus.com/api/v2/components.json 2>/dev/null)" || body=""
  states="$(printf '%s' "$body" | "$NODE_BIN" -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; }).on("end", () => {
  let api = "unknown";
  let actions = "unknown";
  try {
    const status = new Map(JSON.parse(input).components.map(component => [component.name, component.status]));
    api = status.get("API Requests") ?? api;
    actions = status.get("Actions") ?? actions;
  } catch {
    // Not the page we expected: both stay unknown.
  }
  console.log(`${api}|${actions}`);
});' 2>/dev/null)" || states=""
  case "$states" in
    *"|"*) printf '%s\n' "$states" ;;
    *) printf 'unknown|unknown\n' ;;
  esac
}

sleep_for_poll() {
  sleep "$POLL_SECONDS"
}

# Nothing retries this release afterwards: the dispatchers set the wave aside and build a fresh one,
# so the release is deleted instead of being left behind.
give_up() {
  log "$*"
  gh_bounded release delete "$RELEASE_TAG" --repo "$REPO" --yes --cleanup-tag || true
  date -u +%FT%TZ > "$STATE_DIR/failed"
  exit 1
}

# What this process knows about the publication in flight. Each step below either finds its work done
# and returns 0, or logs why it is waiting, sleeps and returns 1, and the loop starts its checks over.
UPLOADED=""
DEPLOY_VERIFIED=""
DEPLOY_DISPATCHED=""
DEPLOY_DISPATCHED_AT=""
PREVIOUS_DEPLOY_RUN_ID=0
DEPLOY_RUN_ID=""
DEPLOY_RERUN=""
IMPORT_DISPATCH_COUNT=0
IMPORT_TRIGGERED=""
IMPORT_DISPATCHED_AT=""
PREVIOUS_RUN_ID=""
IMPORT_RUN_ID=""

deploy_run_line() {
  local run_id="$1"
  gh_bounded run view "$run_id" \
    --repo "$REPO" \
    --json status,conclusion,url \
    --jq "[\"$run_id\",.status,.conclusion,.url] | @tsv" \
    2>/dev/null || true
}

# Sets DEPLOY_RUN_ID to the deployment this process dispatched: the first run created after the newest
# one seen before the dispatch, and no earlier than the dispatch itself.
discover_dispatched_deploy() {
  local previous_run_id="$1"
  local dispatched_since="$2"
  local dispatched_run_id

  dispatched_run_id="$(gh_bounded run list \
    --repo "$REPO" \
    --workflow deploy.yml \
    --event workflow_dispatch \
    --limit 30 \
    --json databaseId,createdAt \
    --jq ".[] | select(.databaseId > $previous_run_id and .createdAt >= \"$dispatched_since\") | .databaseId" \
    2>/dev/null | sort -n | head -1 || true)"
  if [[ "$dispatched_run_id" =~ ^[0-9]+$ ]]; then
    DEPLOY_RUN_ID="$dispatched_run_id"
  fi
}

# Sets IMPORT_RUN_ID to the import run this process dispatched.
discover_dispatched_import() {
  local previous_run_id="$1"
  local dispatched_since="$2"
  local candidate_run_id
  local candidate_kind

  if ! [[ "$previous_run_id" =~ ^[0-9]+$ ]]; then
    previous_run_id=0
  fi

  # Only runs created after this dispatch are candidates. Once the bridge workflow names its runs after
  # their release tag, a run titled with another release's timestamp is excluded as well.
  while IFS= read -r candidate_run_id; do
    candidate_kind="$(gh_bounded run view "$candidate_run_id" --repo "$REPO" \
      --json status,conclusion,jobs \
      --jq "if ([.jobs[]? | select(.name == \"$IMPORT_JOB\" and .conclusion != \"skipped\")] | length) > 0 then \"operation-job\" elif .status == \"completed\" and ([.jobs[]?] | length) == 0 and (.conclusion == \"startup_failure\" or .conclusion == \"failure\" or .conclusion == \"cancelled\" or .conclusion == \"timed_out\") then \"workflow-startup-failure\" else empty end" \
      2>/dev/null || true)"
    if [ "$candidate_kind" = "operation-job" ] || [ "$candidate_kind" = "workflow-startup-failure" ]; then
      IMPORT_RUN_ID="$candidate_run_id"
      if [ "$candidate_kind" = "workflow-startup-failure" ]; then
        log "identified failed import workflow $candidate_run_id before any job started"
      fi
      return
    fi
  done < <(gh_bounded run list \
    --repo "$REPO" \
    --workflow sentence-backfill.yml \
    --event workflow_dispatch \
    --limit 30 \
    --json databaseId,createdAt,displayTitle \
    --jq ".[] | select(.databaseId > $previous_run_id and .createdAt >= \"$dispatched_since\") | (.displayTitle // \"\") as \$title | select((\$title | contains(\"$RELEASE_TAG\")) or (\$title | test(\"[0-9]{8}T[0-9]{6}Z\") | not)) | .databaseId" \
    2>/dev/null | sort -n || true)
}

# Publication waits out a declared major outage of the API or of Actions. A status page that can't be read
# says nothing about GitHub itself, so publication carries on: the calls that follow retry when they fail.
LAST_UNKNOWN_STATE=""
github_ready() {
  local component_state api_state actions_state
  component_state="$(component_states)"
  api_state="${component_state%%|*}"
  actions_state="${component_state#*|}"
  if [ "$api_state" = "major_outage" ] || [ "$actions_state" = "major_outage" ]; then
    log "GitHub not ready (API=$api_state, Actions=$actions_state); checking again later"
    sleep_for_poll
    return 1
  fi
  if [ "$api_state" = "unknown" ] || [ "$actions_state" = "unknown" ]; then
    if [ "$component_state" != "$LAST_UNKNOWN_STATE" ]; then
      log "GitHub status unknown (API=$api_state, Actions=$actions_state); carrying on"
    fi
    LAST_UNKNOWN_STATE="$component_state"
  else
    LAST_UNKNOWN_STATE=""
  fi
}

# An asset left by an earlier attempt may hold a different encryption of the wave, so this archive
# replaces it once. A release that can't be read is checked again later, never uploaded to blindly.
archive_uploaded() {
  local asset_count
  if ! asset_count="$(gh_bounded release view "$RELEASE_TAG" \
    --repo "$REPO" \
    --json assets \
    --jq "[.assets[] | select(.name == \"$ASSET_NAME\")] | length" \
    2>/dev/null)"; then
    log "could not read release $RELEASE_TAG; checking again later"
    sleep_for_poll
    return 1
  fi
  if [ -n "$UPLOADED" ] && [ "$asset_count" = "1" ]; then
    return 0
  fi
  log "uploading verified $ASSET_NAME archive"
  if ! GH_CALL_TIMEOUT_SECONDS="${GH_UPLOAD_TIMEOUT_SECONDS:-3600}" \
    gh_bounded release upload "$RELEASE_TAG" "$ARCHIVE" --repo "$REPO" --clobber; then
    log "archive upload did not complete; retrying later"
    sleep_for_poll
    return 1
  fi
  UPLOADED=1
}

# Production must run DEPLOY_SHA before the import does. Its own deployment is followed; when it has
# none, the deploy workflow is dispatched once on main and the run that dispatch started is followed.
# A deployment that failed gets one rerun. A lookup that fails is retried, never taken to mean that no
# deployment exists, and once the deployment has succeeded it is not looked up again.
required_deployment_succeeded() {
  local deploy_line deploy_id deploy_status deploy_conclusion _

  if [ -n "$DEPLOY_RUN_ID" ]; then
    deploy_line="$(deploy_run_line "$DEPLOY_RUN_ID")"
  elif ! deploy_line="$(gh_bounded run list \
    --repo "$REPO" \
    --workflow deploy.yml \
    --commit "$DEPLOY_SHA" \
    --limit 1 \
    --json databaseId,status,conclusion,url \
    --jq 'if length == 0 then empty else .[0] | [.databaseId,.status,.conclusion,.url] | @tsv end' \
    2>/dev/null)"; then
    log "could not query the deployment of $DEPLOY_SHA; checking again later"
    sleep_for_poll
    return 1
  fi
  if [ -z "$deploy_line" ]; then
    if [ -z "$DEPLOY_DISPATCHED" ]; then
      PREVIOUS_DEPLOY_RUN_ID="$(gh_bounded run list \
        --repo "$REPO" \
        --workflow deploy.yml \
        --event workflow_dispatch \
        --limit 1 \
        --json databaseId \
        --jq 'if length == 0 then 0 else .[0].databaseId end' \
        2>/dev/null || printf '0\n')"
      if ! [[ "$PREVIOUS_DEPLOY_RUN_ID" =~ ^[0-9]+$ ]]; then
        PREVIOUS_DEPLOY_RUN_ID=0
      fi
      DEPLOY_DISPATCHED_AT="$(utc_timestamp_ago "$CLOCK_SKEW_SECONDS")"
      log "no deployment run exists for $DEPLOY_SHA; dispatching it explicitly"
      if gh_bounded workflow run deploy.yml --repo "$REPO" --ref main; then
        DEPLOY_DISPATCHED=1
        sleep 20
      fi
    fi
    if [ -n "$DEPLOY_DISPATCHED" ] && [ -z "$DEPLOY_RUN_ID" ]; then
      discover_dispatched_deploy "$PREVIOUS_DEPLOY_RUN_ID" "$DEPLOY_DISPATCHED_AT"
    fi
    if [ -n "$DEPLOY_RUN_ID" ]; then
      deploy_line="$(deploy_run_line "$DEPLOY_RUN_ID")"
    fi
    if [ -z "$deploy_line" ]; then
      log "archive uploaded; waiting to identify the explicitly dispatched deployment"
      sleep_for_poll
      return 1
    fi
  fi

  IFS=$'\t' read -r deploy_id deploy_status deploy_conclusion _ <<< "$deploy_line"
  if [ "$deploy_status" = "completed" ] && [ "$deploy_conclusion" != "success" ]; then
    if [ -z "$DEPLOY_RERUN" ]; then
      log "deployment $deploy_id ended as $deploy_conclusion; requesting one rerun"
      if gh_bounded run rerun "$deploy_id" --repo "$REPO"; then
        DEPLOY_RERUN=1
      fi
    fi
    sleep_for_poll
    return 1
  fi
  if [ "$deploy_status" != "completed" ] || [ "$deploy_conclusion" != "success" ]; then
    log "waiting for required deployment $deploy_id ($deploy_status)"
    sleep_for_poll
    return 1
  fi
  DEPLOY_VERIFIED=1
}

# Each archive gets three fresh import workflows; a cancelled one does not count (import_succeeded).
import_dispatched() {
  if [ -n "$IMPORT_TRIGGERED" ]; then
    return 0
  fi
  if [ "$IMPORT_DISPATCH_COUNT" -ge 3 ]; then
    give_up "$OPERATION import failed three fresh workflows; stopping for inspection"
  fi
  PREVIOUS_RUN_ID="$(gh_bounded run list \
    --repo "$REPO" \
    --workflow sentence-backfill.yml \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq 'if length == 0 then empty else .[0].databaseId end' \
    2>/dev/null || true)"
  IMPORT_DISPATCHED_AT="$(utc_timestamp_ago "$CLOCK_SKEW_SECONDS")"
  log "required deployment succeeded; dispatching $OPERATION import"
  if ! gh_bounded workflow run sentence-backfill.yml \
    --repo "$REPO" \
    --ref main \
    -f operation="$OPERATION" \
    -f release_tag="$RELEASE_TAG"; then
    log "import dispatch failed; retrying later"
    sleep_for_poll
    return 1
  fi
  IMPORT_DISPATCH_COUNT=$((IMPORT_DISPATCH_COUNT + 1))
  IMPORT_TRIGGERED=1
  sleep 20
}

import_identified() {
  if [ -n "$IMPORT_RUN_ID" ]; then
    return 0
  fi
  discover_dispatched_import "$PREVIOUS_RUN_ID" "$IMPORT_DISPATCHED_AT"
  if [ -z "$IMPORT_RUN_ID" ]; then
    log "$OPERATION import dispatched; waiting for its exact run ID"
    sleep 20
    return 1
  fi
}

# A failed import is followed by a fresh workflow after a poll interval.
import_succeeded() {
  local import_line import_status import_conclusion _
  import_line="$(gh_bounded run view "$IMPORT_RUN_ID" \
    --repo "$REPO" \
    --json status,conclusion,url \
    --jq '[.status,.conclusion,.url] | @tsv' \
    2>/dev/null || true)"
  if [ -z "$import_line" ]; then
    log "waiting for import run $IMPORT_RUN_ID to become queryable"
    sleep 120
    return 1
  fi

  IFS=$'\t' read -r import_status import_conclusion _ <<< "$import_line"
  if [ "$import_status" = "completed" ] && [ "$import_conclusion" != "success" ]; then
    if [ "$import_conclusion" = "cancelled" ]; then
      # A newer run in the bridge's concurrency group cancels a pending one, so a cancelled run says
      # nothing about this archive and does not use up an attempt.
      if [ "$IMPORT_DISPATCH_COUNT" -gt 0 ]; then
        IMPORT_DISPATCH_COUNT=$((IMPORT_DISPATCH_COUNT - 1))
      fi
      log "import $IMPORT_RUN_ID was cancelled; retrying without counting it"
    else
      log "import $IMPORT_RUN_ID ended as $import_conclusion; backing off before a fresh workflow"
    fi
    IMPORT_TRIGGERED=""
    IMPORT_RUN_ID=""
    PREVIOUS_RUN_ID=""
    IMPORT_DISPATCHED_AT=""
    sleep_for_poll
    return 1
  fi
  if [ "$import_status" != "completed" ]; then
    log "$OPERATION import $IMPORT_RUN_ID is $import_status"
    sleep 60
    return 1
  fi
}

production_healthy() {
  if ! curl -fsS --max-time 15 https://dictprop.online/api/health >/dev/null; then
    log "import succeeded but production health is not reachable yet"
    sleep 120
    return 1
  fi
}

if [ ! -s "$ARCHIVE" ]; then
  echo "Encrypted archive not found or empty: $ARCHIVE" >&2
  exit 1
fi
if [ "$(basename "$ARCHIVE")" != "$ASSET_NAME" ]; then
  echo "Archive basename must match workflow asset name: $ASSET_NAME" >&2
  exit 1
fi
if [ -s "$STATE_DIR/complete" ]; then
  log "release was already imported and verified"
  exit 0
fi
# Left by an attempt that gave up; this one starts afresh.
rm -f "$STATE_DIR/failed"

PUBLISH_DEADLINE="$(deadline_after "$PUBLISH_DEADLINE_SECONDS")"
log "publisher waiting for GitHub API and Actions recovery"

while :; do
  if deadline_passed "$PUBLISH_DEADLINE"; then
    give_up "$OPERATION import of $RELEASE_TAG was not verified within ${PUBLISH_DEADLINE_SECONDS}s; giving up and deleting the release"
  fi
  github_ready || continue
  archive_uploaded || continue
  if [ -z "$DEPLOY_VERIFIED" ]; then
    required_deployment_succeeded || continue
  fi
  import_dispatched || continue
  import_identified || continue
  import_succeeded || continue
  production_healthy || continue
  break
done

log "$OPERATION import succeeded and production is healthy"
gh_bounded release delete "$RELEASE_TAG" --repo "$REPO" --yes --cleanup-tag || true
date -u +%FT%TZ > "$STATE_DIR/complete"
log "temporary bridge release removed; publisher complete"
