#!/usr/bin/env bash

# Imports one bridge release asset from a GitHub runner. The asset is authenticated and decrypted here,
# for this operation and release tag only, and just then streamed to REMOTE_SCRIPT on the VPS over the
# pinned SSH channel. The plaintext stays in a private directory that is removed when this exits.
set -euo pipefail

OPERATION="${1:?Usage: bridge-import.sh <operation> <asset>}"
ASSET="${2:?Usage: bridge-import.sh <operation> <asset>}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${REMOTE_SCRIPT:?REMOTE_SCRIPT is required}"
: "${SENTENCE_BRIDGE_KEY:?SENTENCE_BRIDGE_KEY is required}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

BRIDGE="$(umask 077 && mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bridge-import.XXXXXX")"
trap 'rm -rf "$BRIDGE"' EXIT

attempt=1
until gh release download "$RELEASE_TAG" --repo "$REPO" --pattern "$ASSET" --dir "$BRIDGE" --clobber; do
  if [ "$attempt" -ge 5 ]; then
    echo "Could not download $ASSET from release $RELEASE_TAG" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 10
done
echo "$ASSET: $(wc -c < "$BRIDGE/$ASSET" | tr -d ' ') encrypted bytes, sha256 $(sha256_of "$BRIDGE/$ASSET")"

node "$OFFLINE_DIR/bridge-crypto.mjs" decrypt --purpose "import:$OPERATION:$RELEASE_TAG" \
  --in "$BRIDGE/$ASSET" --out "$BRIDGE/bundle.tar.gz"
rm -f "$BRIDGE/$ASSET"
bash "$OFFLINE_DIR/vps-ssh.sh" "$REMOTE_SCRIPT" < "$BRIDGE/bundle.tar.gz"
