#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT="${1:-data/offline-backfill/final-sentence-images}"
FIRST_WAVE_MANIFEST="${2:-/tmp/dictprop-sentence-wave-1/manifest.json}"
FIRST_WAVE_TAG="${3:-sentence-images-20260720T004225Z}"
REQUIRED_DEPLOY_SHA="${4:-d533097}"
CHECKPOINTS="${SENTENCE_WAVE_CHECKPOINTS:-1200 1500 1714}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-/tmp/dictprop_sentence_bridge_key}"
STATE_ROOT="${SENTENCE_WAVE_STATE_ROOT:-/tmp/dictprop-staged-sentence-backfill}"

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
  node -e 'const fs=require("fs"); const ids=new Set(); for (const path of process.argv.slice(1)) { for (const entry of JSON.parse(fs.readFileSync(path,"utf8")).entries) ids.add(entry.id); } console.log(ids.size)' "$@"
}

if [ ! -s "$FIRST_WAVE_MANIFEST" ]; then
  echo "First-wave manifest is missing: $FIRST_WAVE_MANIFEST" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi

mkdir -p "$STATE_ROOT"
PUBLISHED_MANIFESTS=("$FIRST_WAVE_MANIFEST")
FIRST_STATE="$(publisher_state_dir "$FIRST_WAVE_TAG")"
log "waiting for first staged wave to finish publishing"
while [ ! -s "$FIRST_STATE/complete" ]; do
  sleep 300
done

for CHECKPOINT in $CHECKPOINTS; do
  if ! [[ "$CHECKPOINT" =~ ^[0-9]+$ ]]; then
    echo "Invalid sentence wave checkpoint: $CHECKPOINT" >&2
    exit 1
  fi

  PUBLISHED_COUNT="$(manifest_count "${PUBLISHED_MANIFESTS[@]}")"
  if [ "$PUBLISHED_COUNT" -ge "$CHECKPOINT" ]; then
    log "checkpoint $CHECKPOINT already covered by $PUBLISHED_COUNT published sentences"
    continue
  fi

  log "waiting for at least $CHECKPOINT accepted saved-sentence images"
  while [ "$(accepted_count)" -lt "$CHECKPOINT" ]; do
    sleep 300
  done

  WAVE_DIR="$STATE_ROOT/wave-$CHECKPOINT"
  mkdir -p "$WAVE_DIR"
  RESULT="$(node scripts/offline/prepare-sentence-backfill-wave.mjs \
    "$SOURCE_ROOT" \
    "$WAVE_DIR" \
    "${PUBLISHED_MANIFESTS[@]}")"
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "checkpoint $CHECKPOINT contains no unpublished images"
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

  ARCHIVE="$STATE_ROOT/wave-$CHECKPOINT.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json images \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'sentence-images-wave-%s-%s\n' "$CHECKPOINT" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
    || "$GH_BIN" release create "$RELEASE_TAG" \
      --repo "$REPO" \
      --title "Temporary encrypted sentence image wave $CHECKPOINT" \
      --notes "Locally generated, strictly reviewed sentence metadata and images; removed after verified import." \
      --latest=false; do
    log "GitHub release creation unavailable for checkpoint $CHECKPOINT; retrying later"
    sleep 300
  done

  scripts/offline/publish-sentence-backfill-wave.sh \
    "$RELEASE_TAG" \
    "$ARCHIVE" \
    "$REQUIRED_DEPLOY_SHA" \
    300
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "checkpoint $CHECKPOINT published ($WAVE_COUNT new sentences)"
done

log "all staged saved-sentence backfill checkpoints are published"
