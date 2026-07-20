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
DEPLOY_SHA="$5"
POLL_SECONDS="${6:-300}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
GH_BIN="${GH_BIN:-./.gh}"
STATE_KEY="$(printf '%s' "$RELEASE_TAG" | tr -c 'A-Za-z0-9._-' '_')"
STATE_DIR="${TMPDIR:-/tmp}/dictprop-publish-${STATE_KEY}"

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
    --jq '.[0] | [.databaseId,.status,.conclusion,.url] | @tsv' \
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
    PREVIOUS_RUN_ID="$($GH_BIN run list \
      --repo "$REPO" \
      --workflow sentence-backfill.yml \
      --event workflow_dispatch \
      --limit 1 \
      --json databaseId \
      --jq '.[0].databaseId' \
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
    date -u +%FT%TZ > "$STATE_DIR/import-triggered"
    sleep 20
  fi

  if [ ! -s "$STATE_DIR/import-run" ]; then
    PREVIOUS_RUN_ID="$(tr -d '[:space:]' < "$STATE_DIR/previous-run")"
    IMPORT_ID="$($GH_BIN run list \
      --repo "$REPO" \
      --workflow sentence-backfill.yml \
      --event workflow_dispatch \
      --limit 10 \
      --json databaseId \
      --jq "[.[] | select((.databaseId | tostring) != \"$PREVIOUS_RUN_ID\")][0].databaseId" \
      2>/dev/null || true)"
    if [ -z "$IMPORT_ID" ]; then
      log "import dispatched; waiting for its run ID"
      sleep 120
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
    if [ ! -e "$STATE_DIR/import-rerun" ]; then
      log "import $IMPORT_ID ended as $IMPORT_CONCLUSION; requesting one rerun"
      if "$GH_BIN" run rerun "$IMPORT_ID" --repo "$REPO"; then
        touch "$STATE_DIR/import-rerun"
      fi
    fi
    sleep_for_poll
    continue
  fi
  if [ "$IMPORT_STATUS" != "completed" ]; then
    log "$OPERATION import $IMPORT_ID is $IMPORT_STATUS"
    sleep 180
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
