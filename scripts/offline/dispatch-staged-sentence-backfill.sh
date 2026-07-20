#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT="${1:-data/offline-backfill/final-sentence-images}"
BATCH_SIZE="${2:-100}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-/tmp/dictprop_sentence_bridge_key}"
STATE_ROOT="${SENTENCE_WAVE_STATE_ROOT:-/tmp/dictprop-staged-sentence-backfill-v2}"
COOLDOWN_SECONDS="${SENTENCE_WAVE_COOLDOWN_SECONDS:-60}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

publisher_state_dir() {
  local tag="$1"
  local state_key
  state_key="$(printf '%s' "$tag" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/dictprop-publish-%s\n' "${TMPDIR:-/tmp}" "$state_key"
}

accepted_count() {
  find "$SOURCE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' '
}

manifest_count() {
  if [ "$#" -eq 0 ]; then
    printf '0\n'
    return
  fi
  node -e 'const fs=require("fs"); const ids=new Set(); for (const path of process.argv.slice(1)) { for (const entry of JSON.parse(fs.readFileSync(path,"utf8")).entries) ids.add(entry.id); } console.log(ids.size)' "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "Sentence batch size must be a positive integer" >&2
  exit 1
fi
if [ ! -s "$SOURCE_ROOT/manifest.json" ]; then
  echo "Sentence manifest is missing: $SOURCE_ROOT/manifest.json" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi

TOTAL_COUNT="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).entries.length)' "$SOURCE_ROOT/manifest.json")"
mkdir -p "$STATE_ROOT"

# Recover a wave that completed remotely just before a local restart.
while IFS= read -r tag_file; do
  wave_dir="$(dirname "$tag_file")"
  release_tag="$(tr -d '[:space:]' < "$tag_file")"
  publisher_state="$(publisher_state_dir "$release_tag")"
  if [ -s "$publisher_state/complete" ]; then
    cp "$publisher_state/complete" "$wave_dir/published"
  fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name release-tag | sort)

PUBLISHED_MANIFESTS=()
while IFS= read -r manifest; do
  if [ -s "$(dirname "$manifest")/published" ]; then
    PUBLISHED_MANIFESTS+=("$manifest")
  fi
done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name manifest.json | sort)

while :; do
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    PUBLISHED_COUNT=0
  else
    PUBLISHED_COUNT="$(manifest_count "${PUBLISHED_MANIFESTS[@]}")"
  fi
  if [ "$PUBLISHED_COUNT" -ge "$TOTAL_COUNT" ]; then
    date -u +%FT%TZ > "$STATE_ROOT/complete"
    log "all $TOTAL_COUNT saved sentences are published"
    break
  fi

  ACCEPTED_COUNT="$(accepted_count)"
  READY_COUNT=$((ACCEPTED_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$ACCEPTED_COUNT" -lt "$TOTAL_COUNT" ]; then
    log "$READY_COUNT unpublished saved sentences ready; waiting for batch size $BATCH_SIZE"
    sleep 300
    continue
  fi

  WAVE_NUMBER=$((${#PUBLISHED_MANIFESTS[@]} + 1))
  WAVE_NAME="wave-$(printf '%04d' "$WAVE_NUMBER")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    RESULT="$(node scripts/offline/prepare-sentence-backfill-wave.mjs \
      "$SOURCE_ROOT" \
      "$WAVE_DIR" \
      "$BATCH_SIZE")"
  else
    RESULT="$(node scripts/offline/prepare-sentence-backfill-wave.mjs \
      "$SOURCE_ROOT" \
      "$WAVE_DIR" \
      "$BATCH_SIZE" \
      "${PUBLISHED_MANIFESTS[@]}")"
  fi
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "no unpublished verified sentences were found; retrying later"
    sleep 300
    continue
  fi

  /tmp/dictprop-mflux/bin/python - "$WAVE_DIR" <<'PY'
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(sys.argv[1])
entries = json.loads((root / 'manifest.json').read_text())['entries']
for entry in entries:
    image_path = root / entry['imageFile']
    with Image.open(image_path) as image:
        if image.size not in {(1024, 576), (768, 432)} or image.format != 'WEBP':
            raise RuntimeError(f'invalid final image: {image_path} {image.size} {image.format}')
        image.verify()
print(f'Validated {len(entries)} staged sentence entries')
PY

  ARCHIVE="$WAVE_DIR/sentence-backfill.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json images \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'sentence-images-%s-%s\n' "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  PUBLISHER_STATE="$(publisher_state_dir "$RELEASE_TAG")"
  if [ ! -s "$PUBLISHER_STATE/complete" ]; then
    until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
      || "$GH_BIN" release create "$RELEASE_TAG" \
        --repo "$REPO" \
        --title "Temporary encrypted sentence image $WAVE_NAME" \
        --notes "Locally generated and strictly reviewed sentence metadata and images; removed after verified import." \
        --latest=false; do
      log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
      sleep 300
    done
  fi

  scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" \
    "$ARCHIVE" \
    sentence-backfill.enc \
    import \
    "$REQUIRED_DEPLOY_SHA" \
    300
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "$WAVE_NAME published ($WAVE_COUNT new sentences); cooling down for ${COOLDOWN_SECONDS}s"
  sleep "$COOLDOWN_SECONDS"
done
