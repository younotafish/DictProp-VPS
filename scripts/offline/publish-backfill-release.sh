#!/usr/bin/env bash

set -uo pipefail

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
  echo "Usage: $0 <release-tag> <encrypted-archive> <asset-name> <operation> <required-deploy-sha> [poll-seconds]" >&2
  exit 2
fi

RELEASE_TAG="$1"
ARCHIVE="$2"
ASSET_NAME="$3"
OPERATION="$4"
DEPLOY_SHA="$(git rev-parse "$5^{commit}" 2>/dev/null || printf '%s' "$5")"
POLL_SECONDS="${6:-300}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
GH_BIN="${GH_BIN:-./.gh}"
STATE_KEY="$(printf '%s' "$RELEASE_TAG" | tr -c 'A-Za-z0-9._-' '_')"
STATE_DIR="${TMPDIR:-/tmp}/dictprop-publish-${STATE_KEY}"

case "$OPERATION" in
  import|corpus-import|image-import|enrichment-import)
    IMPORT_JOB="$OPERATION"
    ;;
  *)
    echo "Unsupported bridge import operation: $OPERATION" >&2
    exit 2
    ;;
esac

mkdir -p "$STATE_DIR"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

component_states() {
  curl -fsSL https://www.githubstatus.com/api/v2/components.json 2>/dev/null \
    | python3 -c '
import json
import sys

try:
    data = json.load(sys.stdin)
    by_name = {component["name"]: component["status"] for component in data["components"]}
    print(by_name.get("API Requests", "unknown") + "|" + by_name.get("Actions", "unknown"))
except Exception:
    print("unknown|unknown")
'
}

sleep_for_poll() {
  sleep "$POLL_SECONDS"
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

log "publisher waiting for GitHub API and Actions recovery"

while :; do
  COMPONENT_STATE="$(component_states || printf 'unknown|unknown\n')"
  API_STATE="${COMPONENT_STATE%%|*}"
  ACTIONS_STATE="${COMPONENT_STATE#*|}"
  if [ "$API_STATE" = "unknown" ] || [ "$API_STATE" = "major_outage" ] \
    || [ "$ACTIONS_STATE" = "unknown" ] || [ "$ACTIONS_STATE" = "major_outage" ]; then
    log "GitHub not ready (API=$API_STATE, Actions=$ACTIONS_STATE); checking again later"
    sleep_for_poll
    continue
  fi

  ASSET_COUNT="$($GH_BIN release view "$RELEASE_TAG" \
    --repo "$REPO" \
    --json assets \
    --jq "[.assets[] | select(.name == \"$ASSET_NAME\")] | length" \
    2>/dev/null || true)"
  if [ "$ASSET_COUNT" != "1" ]; then
    log "uploading verified $ASSET_NAME archive"
    if ! "$GH_BIN" release upload "$RELEASE_TAG" "$ARCHIVE" --repo "$REPO" --clobber; then
      log "archive upload did not complete; retrying later"
      sleep_for_poll
      continue
    fi
  fi

  DEPLOY_LINE="$($GH_BIN run list \
    --repo "$REPO" \
    --workflow deploy.yml \
    --commit "$DEPLOY_SHA" \
    --limit 1 \
    --json databaseId,status,conclusion,url \
    --jq 'if length == 0 then empty else .[0] | [.databaseId,.status,.conclusion,.url] | @tsv end' \
    2>/dev/null || true)"
  if [ -z "$DEPLOY_LINE" ]; then
    if [ ! -e "$STATE_DIR/deploy-dispatched" ]; then
      log "no deployment run exists for $DEPLOY_SHA; dispatching it explicitly"
      if "$GH_BIN" workflow run deploy.yml --repo "$REPO" --ref main; then
        touch "$STATE_DIR/deploy-dispatched"
        sleep 20
      fi
    else
      log "archive uploaded; waiting for explicitly dispatched deployment $DEPLOY_SHA"
    fi
    sleep_for_poll
    continue
  fi

  IFS=$'\t' read -r DEPLOY_ID DEPLOY_STATUS DEPLOY_CONCLUSION DEPLOY_URL <<< "$DEPLOY_LINE"
  if [ "$DEPLOY_STATUS" = "completed" ] && [ "$DEPLOY_CONCLUSION" != "success" ]; then
    if [ ! -e "$STATE_DIR/deploy-rerun" ]; then
      log "deployment $DEPLOY_ID ended as $DEPLOY_CONCLUSION; requesting one rerun"
      if "$GH_BIN" run rerun "$DEPLOY_ID" --repo "$REPO"; then
        touch "$STATE_DIR/deploy-rerun"
      fi
    fi
    sleep_for_poll
    continue
  fi
  if [ "$DEPLOY_STATUS" != "completed" ] || [ "$DEPLOY_CONCLUSION" != "success" ]; then
    log "waiting for required deployment $DEPLOY_ID ($DEPLOY_STATUS)"
    sleep_for_poll
    continue
  fi

  if [ ! -e "$STATE_DIR/import-triggered" ]; then
    DISPATCH_COUNT="$(cat "$STATE_DIR/import-dispatch-count" 2>/dev/null || printf '0')"
    if ! [[ "$DISPATCH_COUNT" =~ ^[0-9]+$ ]]; then DISPATCH_COUNT=0; fi
    if [ "$DISPATCH_COUNT" -ge 3 ]; then
      log "$OPERATION import failed three fresh workflows; stopping for inspection"
      exit 1
    fi
    PREVIOUS_RUN_ID="$($GH_BIN run list \
      --repo "$REPO" \
      --workflow sentence-backfill.yml \
      --event workflow_dispatch \
      --limit 1 \
      --json databaseId \
      --jq 'if length == 0 then empty else .[0].databaseId end' \
      2>/dev/null || true)"
    printf '%s\n' "$PREVIOUS_RUN_ID" > "$STATE_DIR/previous-run"
    log "required deployment succeeded; dispatching $OPERATION import"
    if ! "$GH_BIN" workflow run sentence-backfill.yml \
      --repo "$REPO" \
      --ref main \
      -f operation="$OPERATION" \
      -f release_tag="$RELEASE_TAG"; then
      log "import dispatch failed; retrying later"
      sleep_for_poll
      continue
    fi
    printf '%s\n' "$((DISPATCH_COUNT + 1))" > "$STATE_DIR/import-dispatch-count"
    date -u +%FT%TZ > "$STATE_DIR/import-triggered"
    sleep 20
  fi

  if [ ! -s "$STATE_DIR/import-run" ]; then
    PREVIOUS_RUN_ID="$(tr -d '[:space:]' < "$STATE_DIR/previous-run")"
    if ! [[ "$PREVIOUS_RUN_ID" =~ ^[0-9]+$ ]]; then PREVIOUS_RUN_ID=0; fi
    IMPORT_ID=""
    while IFS= read -r candidate_run_id; do
      if "$GH_BIN" run view "$candidate_run_id" --repo "$REPO" --json jobs \
        --jq ".jobs[] | select(.name == \"$IMPORT_JOB\" and (.status == \"in_progress\" or (.status == \"completed\" and .conclusion != \"skipped\"))) | .name" \
        2>/dev/null | grep -qx "$IMPORT_JOB"; then
        IMPORT_ID="$candidate_run_id"
        break
      fi
    done < <("$GH_BIN" run list \
      --repo "$REPO" \
      --workflow sentence-backfill.yml \
      --event workflow_dispatch \
      --limit 30 \
      --json databaseId \
      --jq ".[] | select(.databaseId > $PREVIOUS_RUN_ID) | .databaseId" \
      2>/dev/null || true)
    if [ -z "$IMPORT_ID" ]; then
      log "$OPERATION import dispatched; waiting for its exact run ID"
      sleep 20
      continue
    fi
    printf '%s\n' "$IMPORT_ID" > "$STATE_DIR/import-run"
  fi

  IMPORT_ID="$(tr -d '[:space:]' < "$STATE_DIR/import-run")"
  IMPORT_LINE="$($GH_BIN run view "$IMPORT_ID" \
    --repo "$REPO" \
    --json status,conclusion,url \
    --jq '[.status,.conclusion,.url] | @tsv' \
    2>/dev/null || true)"
  if [ -z "$IMPORT_LINE" ]; then
    log "waiting for import run $IMPORT_ID to become queryable"
    sleep 120
    continue
  fi

  IFS=$'\t' read -r IMPORT_STATUS IMPORT_CONCLUSION IMPORT_URL <<< "$IMPORT_LINE"
  if [ "$IMPORT_STATUS" = "completed" ] && [ "$IMPORT_CONCLUSION" != "success" ]; then
    log "import $IMPORT_ID ended as $IMPORT_CONCLUSION; backing off before a fresh workflow"
    rm -f "$STATE_DIR/import-triggered" "$STATE_DIR/import-run" \
      "$STATE_DIR/previous-run" "$STATE_DIR/import-rerun"
    sleep_for_poll
    continue
  fi
  if [ "$IMPORT_STATUS" != "completed" ]; then
    log "$OPERATION import $IMPORT_ID is $IMPORT_STATUS"
    sleep 60
    continue
  fi

  if ! curl -fsS --max-time 15 https://dictprop.online/api/health >/dev/null; then
    log "import succeeded but production health is not reachable yet"
    sleep 120
    continue
  fi

  log "$OPERATION import succeeded and production is healthy"
  "$GH_BIN" release delete "$RELEASE_TAG" --repo "$REPO" --yes --cleanup-tag || true
  date -u +%FT%TZ > "$STATE_DIR/complete"
  log "temporary bridge release removed; publisher complete"
  break
done
