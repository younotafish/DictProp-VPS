#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT="${1:-data/offline-backfill/authoritative-vocab-images}"
BATCH_SIZE="${2:-100}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
STATE_ROOT="${OFFLINE_IMAGE_WAVE_STATE_ROOT:-/tmp/dictprop-staged-offline-images}"
COOLDOWN_SECONDS="${OFFLINE_IMAGE_WAVE_COOLDOWN_SECONDS:-60}"
SENTENCE_COMPLETE_MARKER="${SENTENCE_WAVE_COMPLETE_MARKER:-/tmp/dictprop-staged-sentence-backfill-v2/complete}"
CORPUS_MANIFEST="${OFFLINE_IMAGE_CORPUS_MANIFEST:-data/offline-backfill/final-reconciliation/usage-adjudicated-corpus-manifest.json}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

accepted_count() {
  find "$SOURCE_ROOT/images" -maxdepth 1 -type f -name '*.webp' 2>/dev/null | wc -l | tr -d ' '
}

manifest_count() {
  if [ "$#" -eq 0 ]; then
    printf '0\n'
    return
  fi
  node -e 'const fs=require("fs"); const ids=new Set(); for (const path of process.argv.slice(1)) { for (const entry of JSON.parse(fs.readFileSync(path,"utf8")).entries) ids.add(entry.imageId); } console.log(ids.size)' "$@"
}

publisher_state_dir() {
  local tag="$1"
  local state_key
  state_key="$(printf '%s' "$tag" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/dictprop-publish-%s\n' "${TMPDIR:-/tmp}" "$state_key"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "Image batch size must be a positive integer" >&2
  exit 1
fi
if [ ! -s "$SOURCE_ROOT/manifest.json" ]; then
  echo "Offline-image manifest is missing: $SOURCE_ROOT/manifest.json" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi

TOTAL_COUNT="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).entries.length)' "$SOURCE_ROOT/manifest.json")"
mkdir -p "$STATE_ROOT"

if [ -s "$CORPUS_MANIFEST" ]; then
  node scripts/offline/verify-offline-image-manifest.mjs \
    "$SOURCE_ROOT/manifest.json" \
    "$CORPUS_MANIFEST"
fi

log "waiting for staged saved-sentence imports before publishing vocabulary images"
while [ ! -s "$SENTENCE_COMPLETE_MARKER" ]; do
  sleep 300
done

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
    log "all $TOTAL_COUNT authoritative vocabulary images are published"
    break
  fi

  ACCEPTED_COUNT="$(accepted_count)"
  READY_COUNT=$((ACCEPTED_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$ACCEPTED_COUNT" -lt "$TOTAL_COUNT" ]; then
    log "$READY_COUNT unpublished images ready; waiting for batch size $BATCH_SIZE"
    sleep 60
    continue
  fi

  WAVE_NUMBER=$((${#PUBLISHED_MANIFESTS[@]} + 1))
  WAVE_NAME="wave-$(printf '%04d' "$WAVE_NUMBER")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
  if [ "${#PUBLISHED_MANIFESTS[@]}" -eq 0 ]; then
    RESULT="$(node scripts/offline/prepare-offline-image-wave.mjs \
      "$SOURCE_ROOT" \
      "$WAVE_DIR" \
      "$BATCH_SIZE")"
  else
    RESULT="$(node scripts/offline/prepare-offline-image-wave.mjs \
      "$SOURCE_ROOT" \
      "$WAVE_DIR" \
      "$BATCH_SIZE" \
      "${PUBLISHED_MANIFESTS[@]}")"
  fi
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "no unpublished verified images were found; retrying later"
    sleep 60
    continue
  fi

  node - "$WAVE_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

(async () => {
  const root = process.argv[2];
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).entries;
  for (const entry of entries) {
    const imagePath = path.join(root, entry.imageFile);
    const metadata = await sharp(imagePath, { failOn: 'error' }).metadata();
    const validSize = (metadata.width === 1024 && metadata.height === 576)
      || (metadata.width === 768 && metadata.height === 432);
    if (!validSize || metadata.format !== 'webp') {
      throw new Error(
        `invalid final image: ${imagePath} ${metadata.width}x${metadata.height} ${metadata.format}`,
      );
    }
  }
  console.log(`Validated ${entries.length} staged offline images`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
NODE

  ARCHIVE="$WAVE_DIR/offline-images.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json images \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'vocab-images-%s-%s\n' "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  PUBLISHER_STATE="$(publisher_state_dir "$RELEASE_TAG")"
  if [ ! -s "$PUBLISHER_STATE/complete" ]; then
    until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
      || "$GH_BIN" release create "$RELEASE_TAG" \
        --repo "$REPO" \
        --title "Temporary encrypted vocabulary image $WAVE_NAME" \
        --notes "Locally generated and strictly reviewed vocabulary images; removed after verified import." \
        --latest=false; do
      log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
      sleep 300
    done
  fi

  scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" \
    "$ARCHIVE" \
    offline-images.enc \
    image-import \
    "$REQUIRED_DEPLOY_SHA" \
    300
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "$WAVE_NAME published ($WAVE_COUNT new images); cooling down for ${COOLDOWN_SECONDS}s"
  sleep "$COOLDOWN_SECONDS"
done

printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
log "vocabulary image publication completion marker verified: $PUBLISHED_COUNT/$TOTAL_COUNT"
