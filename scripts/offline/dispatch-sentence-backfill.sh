#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-data/offline-backfill/final-sentence-images}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
PYTHON_BIN="${PYTHON_BIN:-/tmp/dictprop-mflux/bin/python}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-/tmp/dictprop_sentence_bridge_key}"
ARCHIVE="${SENTENCE_BACKFILL_ARCHIVE:-/tmp/sentence-backfill.enc}"

retry() {
  local attempt=0
  until "$@"; do
    attempt=$((attempt + 1))
    printf '[%s] command failed (attempt %s); retrying in 60s: %s\n' "$(date -u +%FT%TZ)" "$attempt" "$*" >&2
    sleep 60
  done
}

bundle_ready() {
  node - "$ROOT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
try {
  const targets = JSON.parse(fs.readFileSync(path.join(root, 'targets.json'))).targets;
  const entries = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).entries;
  if (!Array.isArray(targets) || !Array.isArray(entries) || targets.length === 0 || targets.length !== entries.length) {
    process.exit(1);
  }
  const targetIds = new Set(targets.map(target => target.imageId));
  const entryById = new Map(entries.map(entry => [entry.id, entry]));
  if (targetIds.size !== targets.length || entryById.size !== entries.length) process.exit(1);
  for (const target of targets) {
    const entry = entryById.get(target.imageId);
    if (!entry || entry.imageFile !== `images/${target.filename}` ||
        !/^\/[^/\n]+\/$/.test(entry.analysis?.naturalSpeechIpa || '') ||
        !fs.existsSync(path.join(root, entry.imageFile))) {
      process.exit(1);
    }
  }
} catch {
  process.exit(1);
}
NODE
}

while ! bundle_ready; do
  printf '[%s] sentence backfill is not complete; waiting\n' "$(date -u +%FT%TZ)"
  sleep 600
done

"$PYTHON_BIN" - "$ROOT_DIR" <<'PY'
import json
import sys
from pathlib import Path
from PIL import Image

root = Path(sys.argv[1])
targets = json.loads((root / 'targets.json').read_text())['targets']
entries = json.loads((root / 'manifest.json').read_text())['entries']
if len(targets) != len(entries):
    raise RuntimeError(f'target/manifest mismatch: {len(targets)} != {len(entries)}')
entry_by_id = {entry['id']: entry for entry in entries}
if len(entry_by_id) != len(entries):
    raise RuntimeError('duplicate manifest ids')
for target in targets:
    entry = entry_by_id.get(target['imageId'])
    expected_file = f"images/{target['filename']}"
    if not entry or entry.get('imageFile') != expected_file:
        raise RuntimeError(f"missing manifest target: {target['imageId']}")
    ipa = entry.get('analysis', {}).get('naturalSpeechIpa', '')
    if not (ipa.startswith('/') and ipa.endswith('/') and len(ipa) > 2):
        raise RuntimeError(f"missing natural IPA: {target['imageId']}")
    image_path = root / expected_file
    with Image.open(image_path) as image:
        if image.size not in {(1024, 576), (768, 432)} or image.format != 'WEBP':
            raise RuntimeError(f'invalid final image: {image_path} {image.size} {image.format}')
        image.verify()
print(f'Validated {len(entries)} complete sentence backfill entries')
PY

if [[ ! -s "$KEY_FILE" ]]; then
  printf 'Sentence bridge key is missing: %s\n' "$KEY_FILE" >&2
  exit 1
fi
rm -f "$ARCHIVE"
tar -czf - -C "$ROOT_DIR" manifest.json images \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

tag="sentence-images-$(date -u +%Y%m%dT%H%M%SZ)"
retry "$GH_BIN" release create "$tag" --repo "$REPO" \
  --title 'Temporary encrypted sentence image backfill' \
  --notes 'Locally generated and reviewed sentence metadata and Krea images; delete after verified import.' \
  --latest=false
retry "$GH_BIN" release upload "$tag" "$ARCHIVE" --repo "$REPO" --clobber
retry "$GH_BIN" workflow run sentence-backfill.yml --repo "$REPO" --ref main \
  -f operation=import -f release_tag="$tag"
printf '%s\n' "$tag" > /tmp/dictprop_sentence_image_release_tag
printf '[%s] dispatched sentence backfill %s\n' "$(date -u +%FT%TZ)" "$tag"
