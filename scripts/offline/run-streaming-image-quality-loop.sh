#!/usr/bin/env bash
set -euo pipefail

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
krea_python="${KREA_PYTHON:-/tmp/dictprop-mflux/bin/python}"
codex_concurrency="${CODEX_CONCURRENCY:-32}"
krea_shard_count="${KREA_SHARD_COUNT:-1}"
current="$targets"
first_round=1
watcher_pid=""
generator_pids=()

if ! [[ "$krea_shard_count" =~ ^[0-9]+$ ]] || [[ "$krea_shard_count" -lt 1 ]] || [[ "$krea_shard_count" -gt 8 ]]; then
  echo "KREA_SHARD_COUNT must be an integer from 1 to 8" >&2
  exit 2
fi

mkdir -p "$candidates" "$images" "$work_root"

retry() {
  local attempt=0
  until "$@"; do
    attempt=$((attempt + 1))
    echo "[$(date -u +%FT%TZ)] command failed (attempt ${attempt}); retrying in 60s: $*" >&2
    sleep 60
  done
}

cleanup() {
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

  generator_pids=()
  for ((shard_index = 0; shard_index < krea_shard_count; shard_index += 1)); do
    "$krea_python" scripts/offline/generate-krea-candidates.py \
      "$generation_targets" "$candidates" --candidate-start "$candidate_number" --candidates "$candidate_number" \
      --width "$width" --height "$height" --steps "$steps" \
      --accepted-directory "$images" \
      --shard-count "$krea_shard_count" --shard-index "$shard_index" &
    generator_pids+=("$!")
  done
  for generator_pid in "${generator_pids[@]}"; do
    wait "$generator_pid" || shard_status=1
  done
  generator_pids=()
  return "$shard_status"
}

while [[ "$candidate" -le 99 ]]; do
  round="$(printf '%02d' "$candidate")"
  pass_work="$work_root/pass-$round"
  refined="$work_root/refined-round-$round.json"
  generation_targets="$current"
  if [[ "$first_round" -eq 1 && -n "$first_generation_targets" ]]; then
    generation_targets="$first_generation_targets"
  fi

  echo "[$(date -u +%FT%TZ)] streaming judge/refinement for candidate $candidate with $krea_shard_count Krea shard(s)"
  env CODEX_CONCURRENCY="$codex_concurrency" node scripts/offline/stream-image-quality-pass.mjs \
    "$current" "$candidates" "$images" "$pass_work" "$refined" "$candidate" "$chunk_size" &
  watcher_pid=$!

  retry generate_candidates "$generation_targets" "$candidate"

  watcher_status=0
  wait "$watcher_pid" || watcher_status=$?
  watcher_pid=""
  if [[ "$watcher_status" -ne 0 ]]; then
    retry env CODEX_CONCURRENCY="$codex_concurrency" node scripts/offline/stream-image-quality-pass.mjs \
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

echo "Image quality loop exhausted 99 candidates" >&2
exit 1
