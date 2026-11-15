#!/usr/bin/env bash
# Publishes locally generated Real Life audio clips to production in waves of BATCH_SIZE. A manual tool that
# runs beside the generator, so it waits for clips without a deadline; the cycle doesn't run it.

set -euo pipefail

SOURCE_ROOT="${1:-data/offline-backfill/real-life-qwen3-audio}"
BATCH_SIZE="${2:-50}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
STATE_ROOT="${OFFLINE_AUDIO_WAVE_STATE_ROOT:-/tmp/dictprop-staged-offline-audio-v1}"
COOLDOWN_SECONDS="${OFFLINE_AUDIO_WAVE_COOLDOWN_SECONDS:-30}"
CATALOG_PATH="${OFFLINE_AUDIO_CATALOG:-content/real-life-catalog.json}"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/wave-dispatch.sh"

manifest_count() {
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  "$NODE_BIN" -e 'const fs=require("fs"); const keys=new Set(); for (const p of process.argv.slice(1)) for (const e of JSON.parse(fs.readFileSync(p,"utf8")).entries) keys.add(e.key); console.log(keys.size)' "$@"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "Audio batch size must be a positive integer" >&2
  exit 1
fi
require_positive_integer RELEASE_CREATE_ATTEMPTS "$RELEASE_CREATE_ATTEMPTS"
require_bridge_key
if [ ! -s "$CATALOG_PATH" ]; then
  echo "Real Life catalog is missing: $CATALOG_PATH" >&2
  exit 1
fi

EXPECTED_COUNT="${OFFLINE_AUDIO_EXPECTED_COUNT:-$("$NODE_BIN" -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const s=new Set(c.collections.flatMap(x=>x.sections.flatMap(y=>y.sentences.map(z=>z.text.trim())))); console.log(s.size*2)' "$CATALOG_PATH")}"
load_published_waves

while :; do
  PUBLISHED_COUNT="$(manifest_count ${PUBLISHED_MANIFESTS[@]+"${PUBLISHED_MANIFESTS[@]}"})"
  if [ "$PUBLISHED_COUNT" -ge "$EXPECTED_COUNT" ]; then
    printf '%s\n' "$PUBLISHED_COUNT" > "$STATE_ROOT/complete"
    log "all $PUBLISHED_COUNT/$EXPECTED_COUNT local audio clips are published"
    break
  fi
  if [ ! -s "$SOURCE_ROOT/manifest.json" ]; then
    log "waiting for the first generated audio manifest"
    sleep 30
    continue
  fi
  AVAILABLE_COUNT="$("$NODE_BIN" -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).entries.length)' "$SOURCE_ROOT/manifest.json")"
  READY_COUNT=$((AVAILABLE_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$AVAILABLE_COUNT" -lt "$EXPECTED_COUNT" ]; then
    log "$READY_COUNT unpublished audio clips ready; waiting for batch size $BATCH_SIZE"
    sleep 30
    continue
  fi

  open_next_wave
  WAVE_COUNT="$(prepare_wave scripts/offline/prepare-offline-audio-wave.mjs "$SOURCE_ROOT" "$WAVE_DIR" "$BATCH_SIZE")"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    discard_wave
    log "no unpublished verified audio was found; retrying later"
    sleep 30
    continue
  fi

  name_wave_release real-life-audio
  # The archive is bound to this operation and release, so it decrypts for no other import.
  ARCHIVE="$WAVE_DIR/offline-audio.enc"
  seal_wave "$ARCHIVE" --purpose "import:audio-import:$RELEASE_TAG" manifest.json audio
  ensure_release "Temporary encrypted Real Life audio $WAVE_NAME" \
    "Locally generated, aligned, and quality-gated Qwen3-TTS audio; removed after verified import."
  publish_wave "$ARCHIVE" offline-audio.enc audio-import
  cool_down_after_wave "$WAVE_COUNT clips"
done
