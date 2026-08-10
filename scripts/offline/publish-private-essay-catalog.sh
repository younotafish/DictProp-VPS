#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "Usage: $0 <catalog.json> [required-deploy-sha] [poll-seconds]" >&2
  exit 2
fi

CATALOG_PATH="$1"
REQUIRED_DEPLOY_SHA="${2:-$(git rev-parse HEAD)}"
POLL_SECONDS="${3:-300}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"

if [ ! -s "$CATALOG_PATH" ]; then
  echo "Private essay catalog is missing: $CATALOG_PATH" >&2
  exit 1
fi
if [ ! -s "$KEY_FILE" ]; then
  echo "Sentence bridge key is missing: $KEY_FILE" >&2
  exit 1
fi
node -e '
const fs = require("fs");
const source = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (source?.version !== 1 || !Array.isArray(source.essays) || source.essays.length === 0) {
  throw new Error("Private essay catalog is invalid");
}
for (const essay of source.essays) {
  if (essay?.collection !== "modern" || !Array.isArray(essay.paragraphs) || essay.sentenceCount < 1) {
    throw new Error(`Invalid private essay: ${essay?.id || "unknown"}`);
  }
}
' "$CATALOG_PATH"

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dictprop-private-essays.XXXXXX")"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

cp "$CATALOG_PATH" "$STAGING_DIR/catalog.json"
ARCHIVE="$STAGING_DIR/private-essay-catalog.enc"
tar -czf - -C "$STAGING_DIR" catalog.json \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$KEY_FILE" -out "$ARCHIVE"

RELEASE_TAG="private-essays-$(date -u +%Y%m%dT%H%M%SZ)"
"$GH_BIN" release create "$RELEASE_TAG" \
  --repo "$REPO" \
  --title "Temporary encrypted private essay catalog" \
  --notes "Owner-private study texts; automatically removed after verified import." \
  --latest=false

GH_BIN="$GH_BIN" GITHUB_REPOSITORY="$REPO" \
  "$(dirname "$0")/publish-backfill-release.sh" \
  "$RELEASE_TAG" \
  "$ARCHIVE" \
  private-essay-catalog.enc \
  essay-import \
  "$REQUIRED_DEPLOY_SHA" \
  "$POLL_SECONDS"
