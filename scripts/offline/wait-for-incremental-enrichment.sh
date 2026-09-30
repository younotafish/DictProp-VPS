#!/usr/bin/env bash

set -euo pipefail

GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
POLL_SECONDS="${PRODUCTION_SLOT_POLL_SECONDS:-60}"
WAIT_SECONDS="${PRODUCTION_SLOT_WAIT_SECONDS:-7200}"

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deadline.sh"

if ! [[ "$POLL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Production-slot poll interval must be a non-negative integer" >&2
  exit 1
fi
if ! [[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Production-slot wait limit must be a positive integer" >&2
  exit 1
fi

WAIT_DEADLINE="$(deadline_after "$WAIT_SECONDS")"
while :; do
  if STATUS="$(gh_bounded run list \
    --repo "$REPO" --workflow incremental-enrichment.yml --limit 20 \
    --json status \
    --jq 'if any(.[]; .status != "completed") then "active" else "idle" end' \
    2>/dev/null)"; then
    if [ "$STATUS" = "idle" ]; then exit 0; fi
    if [ "$STATUS" = "active" ]; then
      echo "Incremental enrichment owns the next production slot; waiting ${POLL_SECONDS}s" >&2
    else
      echo "Unexpected incremental enrichment status '$STATUS'; retrying in ${POLL_SECONDS}s" >&2
    fi
  else
    echo "Could not query incremental enrichment status; retrying in ${POLL_SECONDS}s" >&2
  fi
  if deadline_passed "$WAIT_DEADLINE"; then
    echo "Gave up waiting for the production slot after ${WAIT_SECONDS}s, so the caller does not hold its lock indefinitely" >&2
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
