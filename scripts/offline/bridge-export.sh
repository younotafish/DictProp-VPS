#!/usr/bin/env bash

# Runs a production export from a GitHub runner. REMOTE_SCRIPT's output, gzipped on the VPS, streams from
# the pinned SSH channel straight into the bridge cipher, bound to this artifact and run, so plaintext
# reaches neither the log nor the disk. Only the encrypted blob's size and hash are printed.
set -euo pipefail

ARTIFACT="${1:?Usage: bridge-export.sh <artifact> <output>}"
OUTPUT="${2:?Usage: bridge-export.sh <artifact> <output>}"
: "${REMOTE_SCRIPT:?REMOTE_SCRIPT is required}"
: "${SENTENCE_BRIDGE_KEY:?SENTENCE_BRIDGE_KEY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# A dropped connection still ends the plaintext cleanly, so a failed export must leave no blob to upload.
trap 'status=$?; if [ "$status" -ne 0 ]; then rm -f "$OUTPUT"; fi' EXIT
bash "$OFFLINE_DIR/vps-ssh.sh" "$REMOTE_SCRIPT" < /dev/null \
  | node "$OFFLINE_DIR/bridge-crypto.mjs" encrypt --purpose "$ARTIFACT:$GITHUB_RUN_ID" --out "$OUTPUT"
echo "$ARTIFACT: $(wc -c < "$OUTPUT" | tr -d ' ') encrypted bytes, sha256 $(sha256_of "$OUTPUT")"
