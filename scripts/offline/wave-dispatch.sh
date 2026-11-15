#!/usr/bin/env bash
# Sourced by the dispatch-staged-*.sh scripts, which publish a stage's results to production in waves. Each
# dispatcher keeps its arguments, its totals, its wave preparer and its own checks; this file holds what they
# share: the published waves in STATE_ROOT, opening and sealing a wave, its release, and handing it to the
# publisher. A dispatcher sets STATE_ROOT, COOLDOWN_SECONDS and REQUIRED_DEPLOY_SHA before using them.
#
# Dispatchers run from the repository root. The publisher (scripts/offline/publish-backfill-release.sh), the
# wave preparers and sharp resolve from the working directory, which is how the tests stand them in.
#
# PUBLISHED_MANIFESTS may be empty, and bash 3.2 under set -u treats an empty array as unbound, so expand it
# as ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"}.

OFFLINE_DIR="${OFFLINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
. "$OFFLINE_DIR/deadline.sh"

KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
NODE_BIN="${NODE_BIN:-node}"
RELEASE_CREATE_ATTEMPTS="${RELEASE_CREATE_ATTEMPTS:-12}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

# require_positive_integer NAME VALUE
require_positive_integer() {
  if ! [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
    echo "$1 must be a positive integer" >&2
    exit 1
  fi
}

require_bridge_key() {
  if [ ! -s "$KEY_FILE" ]; then
    echo "Sentence bridge key is missing: $KEY_FILE" >&2
    exit 1
  fi
}

# Fills PUBLISHED_MANIFESTS with the manifests of STATE_ROOT's published waves, in wave order. A wave whose
# publisher verified its import before the dispatcher stopped is marked published first. Waves set aside as
# wave-N.failed are left out.
PUBLISHED_MANIFESTS=()
load_published_waves() {
  local tag_file manifest
  mkdir -p "$STATE_ROOT"
  while IFS= read -r tag_file; do
    if [ -s "$(dirname "$tag_file")/publisher/complete" ]; then
      cp "$(dirname "$tag_file")/publisher/complete" "$(dirname "$tag_file")/published"
    fi
  done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name release-tag ! -path '*.failed*' | sort)
  while IFS= read -r manifest; do
    if [ -s "$(dirname "$manifest")/published" ]; then PUBLISHED_MANIFESTS+=("$manifest"); fi
  done < <(find "$STATE_ROOT" -mindepth 2 -maxdepth 2 -type f -name manifest.json ! -path '*.failed*' | sort)
}

# The number after the highest wave in STATE_ROOT, so a wave directory is never prepared twice. The other
# dispatchers number a wave one past the waves published, which resumes an unpublished wave in place.
next_wave_number() {
  local next=1 wave_dir suffix number
  while IFS= read -r wave_dir; do
    suffix="${wave_dir##*/wave-}"
    number=$((10#$suffix))
    if [ "$number" -ge "$next" ]; then next=$((number + 1)); fi
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -name 'wave-[0-9][0-9][0-9][0-9]' | sort)
  printf '%s\n' "$next"
}

# open_wave NUMBER: sets WAVE_NAME and WAVE_DIR, and creates the directory.
open_wave() {
  WAVE_NAME="wave-$(printf '%04d' "$1")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
}

# prepare_wave PREPARER ARG...: runs the wave preparer, which skips the published waves' entries, and prints
# how many entries it put in the wave.
prepare_wave() {
  local result
  result="$("$NODE_BIN" "$@" ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})" || return
  printf '%s' "$result" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))'
}

# Every image in the wave must be a WebP of 1024x576 or 768x432 that sharp reads without error.
# verify_wave_images DESCRIPTION, where DESCRIPTION names the wave's entries in the log.
verify_wave_images() {
  "$NODE_BIN" - "$WAVE_DIR" "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

(async () => {
  const [root, description] = process.argv.slice(2);
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).entries;
  for (const entry of entries) {
    const imagePath = path.join(root, entry.imageFile);
    const metadata = await sharp(imagePath, { failOn: 'error' }).metadata();
    const validSize = (metadata.width === 1024 && metadata.height === 576)
      || (metadata.width === 768 && metadata.height === 432);
    if (!validSize || metadata.format !== 'webp') {
      throw new Error(`invalid wave image: ${imagePath} ${metadata.width}x${metadata.height} ${metadata.format}`);
    }
  }
  console.log(`Validated ${entries.length} ${description}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
NODE
}

# name_wave_release PREFIX: sets RELEASE_TAG, the wave's release, named once and kept with the wave.
name_wave_release() {
  local tag_file="$WAVE_DIR/release-tag"
  if [ ! -s "$tag_file" ]; then
    printf '%s-%s-%s\n' "$1" "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$tag_file"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$tag_file")"
}

# seal_wave ARCHIVE --purpose PURPOSE FILE...: encrypts the wave's files into ARCHIVE for that purpose only.
# Each dispatcher spells out the purpose, import:<operation>:<release tag>, so the import job an archive
# decrypts for is visible where the archive is made.
seal_wave() {
  local archive="$1"
  if [ "$#" -lt 4 ] || [ "$2" != --purpose ]; then
    echo "seal_wave: usage: seal_wave ARCHIVE --purpose PURPOSE FILE..." >&2
    exit 2
  fi
  local purpose="$3"
  shift 3
  rm -f "$archive"
  tar -czf - -C "$WAVE_DIR" "$@" \
    | "$NODE_BIN" "$OFFLINE_DIR/bridge-crypto.mjs" encrypt --key-file "$KEY_FILE" \
      --purpose "$purpose" --out "$archive"
}

# ensure_release TITLE NOTES: creates the wave's release unless it exists or the wave is already published,
# trying RELEASE_CREATE_ATTEMPTS times, five minutes apart.
ensure_release() {
  local attempts=0
  if [ -s "$WAVE_DIR/publisher/complete" ]; then return 0; fi
  until gh_bounded release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
    || gh_bounded release create "$RELEASE_TAG" --repo "$REPO" --title "$1" --notes "$2" --latest=false; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$RELEASE_CREATE_ATTEMPTS" ]; then
      log "GitHub release creation for $WAVE_NAME failed $attempts times; giving up for this run" >&2
      exit 1
    fi
    log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
    sleep 300
  done
}

# The failed wave is kept for inspection under a name the dispatchers ignore, and its entries go into a
# fresh wave with a new release on the next run.
set_wave_aside() {
  local failed="$1.failed"
  if [ -e "$failed" ]; then failed="$1.failed-$(date -u +%Y%m%dT%H%M%SZ)"; fi
  mv "$1" "$failed"
  log "publication of ${1##*/} failed; set it aside as ${failed##*/} so the next run starts a fresh wave"
}

# publish_wave ARCHIVE ASSET OPERATION: has the publisher import the wave, keeping its state in the wave.
# A wave the publisher gave up on is set aside, and the dispatcher stops; a wave it imported is marked
# published and counts from now on.
publish_wave() {
  if ! PUBLISH_STATE_DIR="$WAVE_DIR/publisher" scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" "$1" "$2" "$3" "$REQUIRED_DEPLOY_SHA" 300; then
    if [ -e "$WAVE_DIR/publisher/failed" ]; then set_wave_aside "$WAVE_DIR"; fi
    exit 1
  fi
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
}

# cool_down_after_wave CONTENTS, where CONTENTS says what the wave held, as in "100 records".
cool_down_after_wave() {
  log "$WAVE_NAME published ($1); cooling down for ${COOLDOWN_SECONDS}s"
  sleep "$COOLDOWN_SECONDS"
}

# wait_or_give_up MESSAGE SECONDS: the runner holds its cycle lock while a dispatcher waits for something to
# publish, so the wait ends at WAIT_DEADLINE, which the dispatcher sets DISPATCH_WAIT_SECONDS ahead.
wait_or_give_up() {
  if deadline_passed "$WAIT_DEADLINE"; then
    log "$1 after ${DISPATCH_WAIT_SECONDS}s; giving up" >&2
    exit 1
  fi
  sleep "$2"
}
