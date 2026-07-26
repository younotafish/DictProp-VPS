#!/usr/bin/env bash

set -euo pipefail

ANALYSIS="${1:?Usage: dispatch-staged-saved-sentence-analyses.sh <analysis.json> [batch-size=5000] [required-deploy-sha]}"
BATCH_SIZE="${2:-5000}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
STATE_ROOT="${SAVED_SENTENCE_ANALYSIS_STATE_ROOT:-/tmp/dictprop-staged-saved-sentence-analyses}"
COOLDOWN_SECONDS="${SAVED_SENTENCE_ANALYSIS_COOLDOWN_SECONDS:-30}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

publisher_state_dir() {
  local state_key
  state_key="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/dictprop-publish-%s\n' "${TMPDIR:-/tmp}" "$state_key"
}

manifest_count() {
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  node -e 'const fs=require("fs"); const ids=new Set(); for(const path of process.argv.slice(1)) for(const entry of JSON.parse(fs.readFileSync(path)).entries) ids.add(entry.id); console.log(ids.size)' "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ] || [ "$BATCH_SIZE" -gt 5000 ]; then
  echo "Saved sentence analysis batch size must be between 1 and 5000" >&2
  exit 1
fi
for required in "$ANALYSIS" "$KEY_FILE"; do
  if [ ! -s "$required" ]; then
    echo "Saved sentence analysis publication input is missing: $required" >&2
    exit 1
  fi
done

TOTAL_COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).entries.length)' "$ANALYSIS")"
mkdir -p "$STATE_ROOT"

while IFS= read -r tag_file; do
  wave_dir="$(dirname "$tag_file")"
  release_tag="$(tr -d '[:space:]' < "$tag_file")"
  publisher_state="$(publisher_state_dir "$release_tag")"
  if [ -s "$publisher_state/complete" ]; then cp "$publisher_state/complete" "$wave_dir/published"; fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name release-tag | sort)

PUBLISHED_MANIFESTS=()
while IFS= read -r manifest; do
  if [ -s "$(dirname "$manifest")/published" ]; then PUBLISHED_MANIFESTS+=("$manifest"); fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name manifest.json | sort)

while :; do
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then PUBLISHED_COUNT=0
  else PUBLISHED_COUNT="$(manifest_count "${PUBLISHED_MANIFESTS[@]}")"; fi
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    date -u +%FT%TZ > "$STATE_ROOT/complete"
    log "saved sentence analysis publication complete: $PUBLISHED_COUNT/$TOTAL_COUNT"
    exit 0
  fi

  WAVE_NUMBER=$((${#PUBLISHED_MANIFESTS[@]} + 1))
  WAVE_NAME="wave-$(printf '%04d' "$WAVE_NUMBER")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    RESULT="$(node scripts/offline/prepare-saved-sentence-analysis-wave.mjs "$ANALYSIS" "$WAVE_DIR" "$BATCH_SIZE")"
  else
    RESULT="$(node scripts/offline/prepare-saved-sentence-analysis-wave.mjs \
      "$ANALYSIS" "$WAVE_DIR" "$BATCH_SIZE" "${PUBLISHED_MANIFESTS[@]}")"
  fi
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    echo "No unpublished saved sentence analyses were found at $PUBLISHED_COUNT/$TOTAL_COUNT" >&2
    exit 1
  fi

  ARCHIVE="$WAVE_DIR/sentence-backfill.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'sentence-grammar-%s-%s\n' "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  PUBLISHER_STATE="$(publisher_state_dir "$RELEASE_TAG")"
  if [ ! -s "$PUBLISHER_STATE/complete" ]; then
    until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
      || "$GH_BIN" release create "$RELEASE_TAG" --repo "$REPO" \
        --title "Temporary encrypted saved sentence grammar $WAVE_NAME" \
        --notes "Locally generated grammar analyses; removed after import." \
        --latest=false; do
      log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
      sleep 300
    done
  fi

  scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" "$ARCHIVE" sentence-backfill.enc import "$REQUIRED_DEPLOY_SHA" 300
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "$WAVE_NAME published ($WAVE_COUNT analyses); cooling down for ${COOLDOWN_SECONDS}s"
  sleep "$COOLDOWN_SECONDS"
done
