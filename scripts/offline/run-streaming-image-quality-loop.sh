#!/usr/bin/env bash
set -euo pipefail

# Image rendering is intentionally local-only. A missing renderer must fail visibly instead of
# silently downloading a model during a scheduled repair. Semantic review runs through Codex.
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export TRANSFORMERS_OFFLINE="${TRANSFORMERS_OFFLINE:-1}"

if [[ $# -lt 4 ]]; then
  echo "Usage: run-streaming-image-quality-loop.sh <targets.json> <candidates-dir> <images-dir> <work-dir> [width=768] [height=432] [steps=6] [candidate=1] [chunk-size=128] [first-generation-targets]" >&2
  exit 2
fi

targets="$1"
candidates="$2"
images="$3"
work_root="$4"
width="${5:-768}"
height="${6:-432}"
steps="${7:-6}"
candidate="${8:-1}"
chunk_size="${9:-128}"
first_generation_targets="${10:-}"
krea_python="${KREA_PYTHON:-${DICTPROP_MFLUX_PYTHON:-${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/mflux/bin/python}}"
codex_image_concurrency="${CODEX_IMAGE_CONCURRENCY:-${CODEX_CONCURRENCY:-4}}"
krea_shard_count="${KREA_SHARD_COUNT:-1}"
image_model="${IMAGE_MODEL:-krea2}"
image_model_quantize="${IMAGE_MODEL_QUANTIZE:-${KREA_QUANTIZE:-}}"
krea_image_source_candidate="${KREA_IMAGE_SOURCE_CANDIDATE:-}"
krea_image_strength="${KREA_IMAGE_STRENGTH:-}"
defer_after="${IMAGE_QUALITY_DEFER_AFTER:-}"
retry_limit="${IMAGE_QUALITY_RETRY_LIMIT:-3}"
retry_delay="${IMAGE_QUALITY_RETRY_DELAY_SECONDS:-60}"
current="$targets"
first_round=1
watcher_pid=""
generator_pids=()

if ! [[ "$krea_shard_count" =~ ^[0-9]+$ ]] || [[ "$krea_shard_count" -lt 1 ]] || [[ "$krea_shard_count" -gt 8 ]]; then
  echo "KREA_SHARD_COUNT must be an integer from 1 to 8" >&2
  exit 2
fi
if [[ "$image_model" != "krea2" && "$image_model" != "ernie-image" && "$image_model" != "ernie-image-turbo" && "$image_model" != "qwen-image" && "$image_model" != "qwen-image-edit" && "$image_model" != "z-image-turbo" ]]; then
  echo "IMAGE_MODEL must be krea2, ernie-image, ernie-image-turbo, qwen-image, qwen-image-edit, or z-image-turbo" >&2
  exit 2
fi
if [[ -n "$image_model_quantize" ]] && [[ "$image_model_quantize" != "4" && "$image_model_quantize" != "8" ]]; then
  echo "IMAGE_MODEL_QUANTIZE (or KREA_QUANTIZE) must be 4 or 8" >&2
  exit 2
fi
if [[ -n "$defer_after" ]] && { ! [[ "$defer_after" =~ ^[0-9]+$ ]] || [[ "$defer_after" -lt 1 ]] || [[ "$defer_after" -gt 99 ]]; }; then
  echo "IMAGE_QUALITY_DEFER_AFTER must be an integer from 1 to 99" >&2
  exit 2
fi
if ! [[ "$retry_limit" =~ ^[0-9]+$ ]] || [[ "$retry_limit" -lt 1 ]] || [[ "$retry_limit" -gt 99 ]]; then
  echo "IMAGE_QUALITY_RETRY_LIMIT must be an integer from 1 to 99" >&2
  exit 2
fi
if ! [[ "$retry_delay" =~ ^[0-9]+$ ]]; then
  echo "IMAGE_QUALITY_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi
if [[ "$image_model" == "qwen-image-edit" ]]; then
  if [[ -z "$krea_image_source_candidate" || -n "$krea_image_strength" ]]; then
    echo "qwen-image-edit requires KREA_IMAGE_SOURCE_CANDIDATE and does not use KREA_IMAGE_STRENGTH" >&2
    exit 2
  fi
elif [[ -n "$krea_image_source_candidate" || -n "$krea_image_strength" ]]; then
  if [[ -z "$krea_image_source_candidate" || -z "$krea_image_strength" ]]; then
    echo "KREA_IMAGE_SOURCE_CANDIDATE and KREA_IMAGE_STRENGTH must be set together" >&2
    exit 2
  fi
  if [[ "$krea_image_source_candidate" != "previous" ]] && ! [[ "$krea_image_source_candidate" =~ ^[0-9]+$ ]]; then
    echo "KREA_IMAGE_SOURCE_CANDIDATE must be an integer or 'previous'" >&2
    exit 2
  fi
fi
if [[ ! -x "$krea_python" ]]; then
  echo "MFLUX runtime is unavailable: $krea_python" >&2
  echo "Run scripts/offline/bootstrap-mflux-runtime.sh first" >&2
  exit 2
fi

mkdir -p "$candidates" "$images" "$work_root"

if node - "$targets" "$images" <<'NODE'
const { existsSync, readFileSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');
const [targetsPath, imagesPath] = process.argv.slice(2);
const payload = JSON.parse(readFileSync(resolve(targetsPath), 'utf8'));
if (!Array.isArray(payload.targets)) throw new Error('Target manifest is invalid');
const imageDir = resolve(imagesPath);
const complete = payload.targets.every(target => {
  const path = join(imageDir, target.filename);
  return existsSync(path) && statSync(path).size > 0;
});
process.exit(complete ? 0 : 1);
NODE
then
  echo "[$(date -u +%FT%TZ)] all target images are already accepted"
  exit 0
fi

# Capped, so a renderer or reviewer that keeps failing ends the loop instead of holding the cycle lock.
retry() {
  local attempt=0
  until "$@"; do
    attempt=$((attempt + 1))
    if [[ "$attempt" -ge "$retry_limit" ]]; then
      echo "[$(date -u +%FT%TZ)] command failed ${attempt} time(s); giving up: $*" >&2
      return 1
    fi
    echo "[$(date -u +%FT%TZ)] command failed (attempt ${attempt}); retrying in ${retry_delay}s: $*" >&2
    sleep "$retry_delay"
  done
}

cleanup() {
  # macOS Bash 3.2 treats an empty array expansion as unset under nounset.
  set +u
  if [[ -n "$watcher_pid" ]] && kill -0 "$watcher_pid" 2>/dev/null; then
    kill "$watcher_pid" 2>/dev/null || true
    wait "$watcher_pid" 2>/dev/null || true
  fi
  for generator_pid in "${generator_pids[@]}"; do
    if kill -0 "$generator_pid" 2>/dev/null; then
      kill "$generator_pid" 2>/dev/null || true
    fi
  done
  for generator_pid in "${generator_pids[@]}"; do
    wait "$generator_pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

generate_candidates() {
  local generation_targets="$1"
  local candidate_number="$2"
  local shard_index
  local shard_status=0
  local resolved_image_source_candidate="$krea_image_source_candidate"
  local generator_args=(
    "$generation_targets" "$candidates" --candidate-start "$candidate_number" --candidates "$candidate_number"
    --width "$width" --height "$height" --steps "$steps" --accepted-directory "$images" --model "$image_model"
  )

  if [[ -n "$image_model_quantize" ]]; then
    generator_args+=(--quantize "$image_model_quantize")
  fi

  if [[ -n "$krea_image_source_candidate" ]]; then
    if [[ "$resolved_image_source_candidate" == "previous" ]]; then
      resolved_image_source_candidate=$((candidate_number - 1))
    fi
    if [[ "$resolved_image_source_candidate" -lt 1 ]]; then
      echo "The previous image candidate is unavailable for candidate $candidate_number" >&2
      return 2
    fi
    generator_args+=(--image-source-candidate "$resolved_image_source_candidate")
    if [[ -n "$krea_image_strength" ]]; then
      generator_args+=(--image-strength "$krea_image_strength")
    fi
  fi

  generator_pids=()
  for ((shard_index = 0; shard_index < krea_shard_count; shard_index += 1)); do
    "$krea_python" scripts/offline/generate-krea-candidates.py \
      "${generator_args[@]}" \
      --shard-count "$krea_shard_count" --shard-index "$shard_index" &
    generator_pids+=("$!")
  done
  for generator_pid in "${generator_pids[@]}"; do
    wait "$generator_pid" || shard_status=1
  done
  generator_pids=()
  return "$shard_status"
}

while [[ "$candidate" -le "${defer_after:-99}" ]]; do
  round="$(printf '%02d' "$candidate")"
  pass_work="$work_root/pass-$round"
  refined="$work_root/refined-round-$round.json"
  generation_targets="$current"
  if [[ "$first_round" -eq 1 && -n "$first_generation_targets" ]]; then
    generation_targets="$first_generation_targets"
  fi

  echo "[$(date -u +%FT%TZ)] streaming judge/refinement for candidate $candidate with $krea_shard_count $image_model shard(s)"
  env CODEX_IMAGE_CONCURRENCY="$codex_image_concurrency" node scripts/offline/stream-image-quality-pass.mjs \
    "$current" "$candidates" "$images" "$pass_work" "$refined" "$candidate" "$chunk_size" &
  watcher_pid=$!

  retry generate_candidates "$generation_targets" "$candidate"

  watcher_status=0
  wait "$watcher_pid" || watcher_status=$?
  watcher_pid=""
  if [[ "$watcher_status" -ne 0 ]]; then
    # Generation has finished, so an image still missing now will never appear.
    retry env CODEX_IMAGE_CONCURRENCY="$codex_image_concurrency" IMAGE_QUALITY_STALL_MINUTES=1 \
      node scripts/offline/stream-image-quality-pass.mjs \
      "$current" "$candidates" "$images" "$pass_work" "$refined" "$candidate" "$chunk_size"
  fi

  rejected_count="$(node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1])); console.log(p.targets.length)" "$refined")"
  accepted_count="$(find "$images" -type f -name '*.webp' | wc -l | tr -d ' ')"
  echo "[$(date -u +%FT%TZ)] candidate $candidate: accepted=$accepted_count, rejected=$rejected_count"
  if [[ "$rejected_count" -eq 0 ]]; then
    echo "[$(date -u +%FT%TZ)] streaming image quality loop complete"
    exit 0
  fi

  current="$refined"
  candidate=$((candidate + 1))
  first_round=0
done

if [[ -n "$defer_after" ]]; then
  # A few concepts defeat the local renderer. Holding the cycle for them would also hold every accepted
  # image, so they wait for a later cycle. Their rejected candidates are removed because the generator
  # reuses any existing candidate file, and a later cycle must render fresh ones.
  deferred_count="$(node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1])); console.log(p.targets.length)" "$current")"
  node - "$current" "$candidates" <<'NODE'
const { readdirSync, readFileSync, unlinkSync } = require('node:fs');
const { join, parse, resolve } = require('node:path');
const [targetsPath, candidatesPath] = process.argv.slice(2);
const stems = new Set(JSON.parse(readFileSync(resolve(targetsPath), 'utf8')).targets
  .map(target => parse(target.filename).name));
for (const file of readdirSync(resolve(candidatesPath))) {
  const match = /^(.+)-\d+\.[^.]+$/.exec(file);
  if (match && stems.has(match[1])) unlinkSync(join(resolve(candidatesPath), file));
}
NODE
  echo "[$(date -u +%FT%TZ)] deferring $deferred_count image(s) that failed $defer_after candidates to a later cycle"
  exit 0
fi

echo "Image quality loop exhausted 99 candidates" >&2
exit 1
