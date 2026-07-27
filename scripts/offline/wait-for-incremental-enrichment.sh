#!/usr/bin/env bash

set -euo pipefail

GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
POLL_SECONDS="${PRODUCTION_SLOT_POLL_SECONDS:-60}"

if ! [[ "$POLL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Production-slot poll interval must be a non-negative integer" >&2
  exit 1
fi

while :; do
  if STATUS="$($GH_BIN run list \
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
  sleep "$POLL_SECONDS"
done
