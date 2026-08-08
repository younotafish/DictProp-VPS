#!/usr/bin/env bash

# macOS still ships Bash 3.2, whose nounset handling treats an explicitly empty array as unbound.
# The publisher begins with zero completed waves, so keep errexit/pipefail without nounset here.
set -eo pipefail

SOURCE_ROOT="${1:-data/offline-backfill/real-life-qwen3-audio}"
BATCH_SIZE="${2:-50}"
REQUIRED_DEPLOY_SHA="${3:-$(git rev-parse HEAD)}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
STATE_ROOT="${OFFLINE_AUDIO_WAVE_STATE_ROOT:-/tmp/dictprop-staged-offline-audio-v1}"
COOLDOWN_SECONDS="${OFFLINE_AUDIO_WAVE_COOLDOWN_SECONDS:-30}"
CATALOG_PATH="${OFFLINE_AUDIO_CATALOG:-content/real-life-catalog.json}"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

manifest_count() {
  if [ "$#" -eq 0 ]; then printf '0\n'; return; fi
  node -e 'const fs=require("fs"); const keys=new Set(); for (const p of process.argv.slice(1)) for (const e of JSON.parse(fs.readFileSync(p,"utf8")).entries) keys.add(e.key); console.log(keys.size)' "$@"
}

publisher_state_dir() {
  local state_key
  state_key="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/dictprop-publish-%s\n' "${TMPDIR:-/tmp}" "$state_key"
}

if ! [[ "$BATCH_SIZE" =~ ^[0-9]+$ ]] || [ "$BATCH_SIZE" -lt 1 ]; then
  echo "Audio batch size must be a positive integer" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi
if [ ! -s "$CATALOG_PATH" ]; then
  echo "Real Life catalog is missing: $CATALOG_PATH" >&2
  exit 1
fi

EXPECTED_COUNT="${OFFLINE_AUDIO_EXPECTED_COUNT:-$(node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const s=new Set(c.collections.flatMap(x=>x.sections.flatMap(y=>y.sentences.map(z=>z.text.trim())))); console.log(s.size*2)' "$CATALOG_PATH")}"
mkdir -p "$STATE_ROOT"

# Recover locally after a publication completed remotely immediately before this process restarted.
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
  PUBLISHED_COUNT="$(manifest_count "${PUBLISHED_MANIFESTS[@]}")"
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
  AVAILABLE_COUNT="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).entries.length)' "$SOURCE_ROOT/manifest.json")"
  READY_COUNT=$((AVAILABLE_COUNT - PUBLISHED_COUNT))
  if [ "$READY_COUNT" -lt "$BATCH_SIZE" ] && [ "$AVAILABLE_COUNT" -lt "$EXPECTED_COUNT" ]; then
    log "$READY_COUNT unpublished audio clips ready; waiting for batch size $BATCH_SIZE"
    sleep 30
    continue
  fi

  WAVE_NUMBER=$((${#PUBLISHED_MANIFESTS[@]} + 1))
  WAVE_NAME="wave-$(printf '%04d' "$WAVE_NUMBER")"
  WAVE_DIR="$STATE_ROOT/$WAVE_NAME"
  mkdir -p "$WAVE_DIR"
  RESULT="$(node scripts/offline/prepare-offline-audio-wave.mjs \
    "$SOURCE_ROOT" "$WAVE_DIR" "$BATCH_SIZE" "${PUBLISHED_MANIFESTS[@]}")"
  WAVE_COUNT="$(printf '%s' "$RESULT" | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waveEntries))')"
  if [ "$WAVE_COUNT" -eq 0 ]; then
    log "no unpublished verified audio was found; retrying later"
    sleep 30
    continue
  fi

  ARCHIVE="$WAVE_DIR/offline-audio.enc"
  rm -f "$ARCHIVE"
  tar -czf - -C "$WAVE_DIR" manifest.json audio \
    | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"
  TAG_FILE="$WAVE_DIR/release-tag"
  if [ ! -s "$TAG_FILE" ]; then
    printf 'real-life-audio-%s-%s\n' "$WAVE_NAME" "$(date -u +%Y%m%dT%H%M%SZ)" > "$TAG_FILE"
  fi
  RELEASE_TAG="$(tr -d '[:space:]' < "$TAG_FILE")"
  PUBLISHER_STATE="$(publisher_state_dir "$RELEASE_TAG")"
  if [ ! -s "$PUBLISHER_STATE/complete" ]; then
    until "$GH_BIN" release view "$RELEASE_TAG" --repo "$REPO" >/dev/null 2>&1 \
      || "$GH_BIN" release create "$RELEASE_TAG" --repo "$REPO" \
        --title "Temporary encrypted Real Life audio $WAVE_NAME" \
        --notes "Locally generated, aligned, and quality-gated Qwen3-TTS audio; removed after verified import." \
        --latest=false; do
      log "GitHub release creation unavailable for $WAVE_NAME; retrying later"
      sleep 300
    done
  fi

  scripts/offline/publish-backfill-release.sh \
    "$RELEASE_TAG" "$ARCHIVE" offline-audio.enc audio-import "$REQUIRED_DEPLOY_SHA" 300
  date -u +%FT%TZ > "$WAVE_DIR/published"
  PUBLISHED_MANIFESTS+=("$WAVE_DIR/manifest.json")
  log "$WAVE_NAME published ($WAVE_COUNT clips); cooling down for ${COOLDOWN_SECONDS}s"
  sleep "$COOLDOWN_SECONDS"
done
