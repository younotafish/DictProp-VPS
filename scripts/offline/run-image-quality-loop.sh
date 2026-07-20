#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "Usage: run-image-quality-loop.sh <targets.json> <candidates-dir> <images-dir> <work-dir> [width=768] [height=432] [steps=6] [candidate=1]" >&2
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
krea_python="${KREA_PYTHON:-/tmp/dictprop-mflux/bin/python}"
codex_concurrency="${CODEX_CONCURRENCY:-32}"
current="$targets"

retry() {
  local attempt=0
  until "$@"; do
    attempt=$((attempt + 1))
    echo "[$(date -u +%FT%TZ)] command failed (attempt ${attempt}); retrying in 60s: $*" >&2
    sleep 60
  done
}

while [[ "$candidate" -le 99 ]]; do
  round="$(printf '%02d' "$candidate")"
  judge_work="$work_root/judge-round-$round"
  echo "[$(date -u +%FT%TZ)] judging image candidate $candidate"
  retry env CODEX_CONCURRENCY="$codex_concurrency" node scripts/offline/judge-image-candidates.mjs \
    "$current" "$candidates" "$images" "$judge_work" "$candidate"

  rejected="$judge_work/rejected-targets.json"
  rejected_count="$(node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1])); console.log(p.targets.length)" "$rejected")"
  accepted_count="$(find "$images" -type f -name '*.webp' | wc -l | tr -d ' ')"
  echo "[$(date -u +%FT%TZ)] round $candidate: accepted=$accepted_count, rejected=$rejected_count"
  if [[ "$rejected_count" -eq 0 ]]; then
    echo "[$(date -u +%FT%TZ)] image quality loop complete"
    exit 0
  fi

  refined="$work_root/refined-round-$round.json"
  refine_work="$work_root/refine-round-$round"
  retry env CODEX_CONCURRENCY="$codex_concurrency" node scripts/offline/refine-rejected-image-prompts.mjs \
    "$rejected" "$refined" "$refine_work"

  candidate=$((candidate + 1))
  echo "[$(date -u +%FT%TZ)] generating candidate $candidate for $rejected_count rejects"
  retry "$krea_python" scripts/offline/generate-krea-candidates.py \
    "$refined" "$candidates" --candidate-start "$candidate" --candidates "$candidate" \
    --width "$width" --height "$height" --steps "$steps"
  current="$refined"
done

echo "Image quality loop exhausted 99 candidates" >&2
exit 1
