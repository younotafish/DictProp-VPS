#!/usr/bin/env bash

# Fetches the export a successful sentence-backfill run left as an encrypted artifact, decrypts it for that
# artifact and run only, and replaces OUTPUT once the JSON parses. The artifact and the run's log are then
# deleted. A blob that fails to decrypt is kept for inspection; GitHub expires it within a day.
set -euo pipefail

USAGE="Usage: fetch-workflow-export.sh <run-id> <corpus-export|sentence-export> <output.json>"
RUN_ID="${1:?$USAGE}"
ARTIFACT="${2:?$USAGE}"
OUTPUT="${3:?$USAGE}"
GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
NODE_BIN="${NODE_BIN:-node}"

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/deadline.sh"

if ! [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "$USAGE" >&2
  exit 2
fi
case "$ARTIFACT" in
  corpus-export|sentence-export) ;;
  *)
    echo "$USAGE" >&2
    exit 2
    ;;
esac

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

sha256_of() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

DOWNLOAD_ROOT="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/dictprop-$ARTIFACT.XXXXXX")"
trap 'rm -rf "$DOWNLOAD_ROOT"' EXIT

# GitHub occasionally resets a download stream or stalls; each attempt starts in an empty directory.
BLOB=""
for attempt in 1 2 3 4 5; do
  attempt_dir="$DOWNLOAD_ROOT/attempt-$attempt"
  mkdir -m 700 "$attempt_dir"
  if GH_CALL_TIMEOUT_SECONDS=600 gh_bounded run download "$RUN_ID" --repo "$REPO" \
    -n "$ARTIFACT" -D "$attempt_dir"; then
    BLOB="$(find "$attempt_dir" -type f -name '*.dpb')"
    if [ -n "$BLOB" ] && [ "$(printf '%s\n' "$BLOB" | wc -l | tr -d ' ')" = 1 ]; then break; fi
    log "artifact $ARTIFACT of run $RUN_ID does not hold exactly one encrypted export"
    exit 1
  fi
  if [ "$attempt" -lt 5 ]; then
    log "$ARTIFACT download failed (attempt $attempt/5); retrying"
    sleep "$((attempt * 5))"
  else
    echo "Could not download artifact $ARTIFACT of run $RUN_ID after 5 attempts" >&2
    exit 1
  fi
done
log "downloaded $ARTIFACT of run $RUN_ID: $(wc -c < "$BLOB" | tr -d ' ') bytes, sha256 $(sha256_of "$BLOB")"

# The output is replaced only by a blob that authenticates for this artifact and run, decompresses and parses.
OUTPUT_TMP="$OUTPUT.tmp"
rm -f "$OUTPUT_TMP"
"$NODE_BIN" "$OFFLINE_DIR/bridge-crypto.mjs" decrypt --gunzip --key-file "$KEY_FILE" \
  --purpose "$ARTIFACT:$RUN_ID" --in "$BLOB" --out "$OUTPUT_TMP"
if ! "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$OUTPUT_TMP"; then
  rm -f "$OUTPUT_TMP"
  echo "Decrypted $ARTIFACT of run $RUN_ID is not valid JSON" >&2
  exit 1
fi
mv "$OUTPUT_TMP" "$OUTPUT"
rm -rf "$DOWNLOAD_ROOT"

# Cleanup failures are logged but don't fail the fetch: the artifact expires within a day regardless.
ARTIFACT_IDS="$(gh_bounded api "repos/$REPO/actions/runs/$RUN_ID/artifacts" \
  --jq ".artifacts[] | select(.name == \"$ARTIFACT\") | .id" 2>/dev/null || true)"
if [ -z "$ARTIFACT_IDS" ]; then
  log "could not find artifact $ARTIFACT of run $RUN_ID to delete; it expires within a day"
fi
for artifact_id in $ARTIFACT_IDS; do
  if [[ "$artifact_id" =~ ^[0-9]+$ ]] \
    && gh_bounded api -X DELETE "repos/$REPO/actions/artifacts/$artifact_id" > /dev/null; then
    log "deleted artifact $artifact_id ($ARTIFACT) of run $RUN_ID"
  else
    log "could not delete artifact $artifact_id of run $RUN_ID; it expires within a day"
  fi
done
if gh_bounded api -X DELETE "repos/$REPO/actions/runs/$RUN_ID/logs" > /dev/null; then
  log "deleted the logs of run $RUN_ID"
else
  log "could not delete the logs of run $RUN_ID"
fi
