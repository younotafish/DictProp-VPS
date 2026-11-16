#!/usr/bin/env bash
# Keeps encrypted copies of production's database on this Mac, off the VPS's one disk. Once the newest copy here is
# OFFSITE_BACKUP_INTERVAL_HOURS old (162 unless set), it dispatches offsite-backup.yml, which packs the VPS's newest
# database copy, the live Caddyfile and a manifest into a gzipped tar encrypted for that run only. This script
# downloads that artifact, authenticates every byte of it without writing any plaintext (bridge-crypto.mjs verify),
# keeps it as <root>/dictprop-db-<UTC time>-<run id>.dpb beside a .json sidecar, keeps the newest OFFSITE_BACKUP_KEEP
# (3) and deletes the artifact and the run's log. ops/RESTORE.md restores from a copy.
#
# It dispatches only while production runs the required commit, whose server has the backup script, and while no
# deploy, import, repair, recovery or other backup is queued or running: a job queued in dictprop-production cancels
# the one waiting there. A failed attempt writes <root>/.last-attempt, and no attempt follows for a day, so a broken
# backup costs one attempt a day. While the root holds no copy, only a run by hand makes one:
# OFFSITE_BACKUP_INTERVAL_HOURS=0 forces an attempt, whatever the copies and the last attempt say. The cycle calls this
# script last, holding the cycle lock; hold the same lock to run it by hand.
#
# Usage: offsite-backup.sh <required-deploy-sha> [root=data/offsite-backups]
# Exits 0 when it kept a new copy or had nothing to do yet, 1 when an attempt failed (the older copies stay), 2 on
# usage.

set -euo pipefail

USAGE="Usage: offsite-backup.sh <required-deploy-sha> [root=data/offsite-backups]"
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "$USAGE" >&2
  exit 2
fi
ROOT="${2:-data/offsite-backups}"
INTERVAL_HOURS="${OFFSITE_BACKUP_INTERVAL_HOURS:-162}"
KEEP="${OFFSITE_BACKUP_KEEP:-3}"
# How long the run may take, from its dispatch, queueing behind production's jobs included.
WAIT_SECONDS="${OFFSITE_BACKUP_WAIT_SECONDS:-3600}"
# How long the download may take, through the proxy, all its attempts together: the artifact is about 6 GB.
DOWNLOAD_SECONDS="${OFFSITE_BACKUP_DOWNLOAD_SECONDS:-3600}"
# An attempt holds dictprop-production for up to half an hour and moves the artifact through the proxy.
RETRY_AFTER_SECONDS=86400
KEY_FILE="${SENTENCE_BRIDGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dictprop/sentence_bridge_key}"
NODE_BIN="${NODE_BIN:-node}"
WORKFLOW=offsite-backup.yml
ARTIFACT=db-backup
CLOCK_SKEW_SECONDS=120

OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/deadline.sh"
. "$OFFLINE_DIR/deploy-state.sh"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

# GitHub matches a deployment by its full head SHA, so the commit must resolve here or be given in full.
if ! REQUIRED_SHA="$(git rev-parse --verify --quiet "$1^{commit}" 2>/dev/null)"; then
  if [[ "$1" =~ ^[0-9a-f]{40}$ ]]; then
    REQUIRED_SHA="$1"
  else
    echo "required-deploy-sha must be a commit this checkout knows or a full 40-character SHA: $1" >&2
    exit 2
  fi
fi
if ! [[ "$INTERVAL_HOURS" =~ ^[0-9]{1,6}$ ]]; then
  echo "OFFSITE_BACKUP_INTERVAL_HOURS must be a whole number of hours, 0 to force a backup" >&2
  exit 2
fi
for setting in KEEP WAIT_SECONDS DOWNLOAD_SECONDS; do
  if ! [[ "${!setting}" =~ ^[1-9][0-9]{0,6}$ ]]; then
    echo "OFFSITE_BACKUP_$setting must be a positive integer" >&2
    exit 2
  fi
done

# How many seconds ago FILE last changed.
age_of() {
  perl -e 'my @s = stat($ARGV[0]) or exit 1; print time - $s[9], "\n"' "$1"
}

# The kept copies, oldest first: their names start with the UTC time they were kept.
copies() {
  find "$ROOT" -maxdepth 1 -type f -name 'dictprop-db-*.dpb' | LC_ALL=C sort
}

umask 077
mkdir -p "$ROOT"
chmod 700 "$ROOT"
# What a killed run left: its download, gh's temporary file among it.
find "$ROOT" -maxdepth 1 -name '.download-*' -exec rm -rf {} +

if [ "$INTERVAL_HOURS" -gt 0 ]; then
  NEWEST="$(copies | tail -n 1)"
  if [ -z "$NEWEST" ]; then
    log "no off-site backup is kept in $ROOT yet, and the first is made by hand: OFFSITE_BACKUP_INTERVAL_HOURS=0 $0 <sha>, holding the cycle lock (ops/RESTORE.md)"
    exit 0
  fi
  AGE="$(age_of "$NEWEST")"
  if [ "$AGE" -lt "$((INTERVAL_HOURS * 3600))" ]; then
    log "the newest off-site backup, $(basename "$NEWEST"), is $((AGE / 3600)) hour(s) old; the next is due at $INTERVAL_HOURS hours"
    exit 0
  fi
  if [ -f "$ROOT/.last-attempt" ]; then
    LAST="$(age_of "$ROOT/.last-attempt")"
    if [ "$LAST" -lt "$RETRY_AFTER_SECONDS" ]; then
      log "an off-site backup attempt failed $((LAST / 3600)) hour(s) ago ($(cat "$ROOT/.last-attempt")); the next attempt waits until a day has passed"
      exit 0
    fi
  fi
fi

CARRIED=0
production_carries "$REQUIRED_SHA" || CARRIED=$?
case "$CARRIED" in
  0) ;;
  1)
    log "production does not run $REQUIRED_SHA yet, and the backup needs that release's server script; trying again next cycle"
    exit 0
    ;;
  *)
    log "could not tell whether production runs $REQUIRED_SHA; trying again next cycle"
    exit 0
    ;;
esac
BUSY=0
production_busy || BUSY=$?
case "$BUSY" in
  1) ;;
  0)
    log "a deploy, import, repair, recovery or backup is queued or running, and the backup would queue behind it; trying again next cycle"
    exit 0
    ;;
  *)
    log "could not tell whether production is busy; trying again next cycle"
    exit 0
    ;;
esac

# From here on a failure is an attempt, which the exit trap records, so the next one waits a day.
FAILURE=""
DOWNLOAD=""
SUCCEEDED=""
finish() {
  local status=$?
  if [ -n "$DOWNLOAD" ]; then rm -rf "$DOWNLOAD"; fi
  if [ -z "$SUCCEEDED" ]; then
    printf '%s %s\n' "$(date -u +%FT%TZ)" "${FAILURE:-stopped with status $status}" > "$ROOT/.last-attempt"
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  FAILURE="$*"
  echo "$*" >&2
  exit 1
}

PREVIOUS_RUN_ID="$(gh_bounded run list --repo "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 1 \
  --json databaseId --jq 'if length == 0 then 0 else .[0].databaseId end' 2>/dev/null || true)"
if ! [[ "$PREVIOUS_RUN_ID" =~ ^[0-9]+$ ]]; then PREVIOUS_RUN_ID=0; fi
# Only runs created after the dispatch qualify, starting a little early in case this clock runs ahead of GitHub's.
SINCE="$(utc_timestamp_ago "$CLOCK_SKEW_SECONDS")"
log "requesting an off-site database backup from production"
gh_bounded workflow run "$WORKFLOW" --repo "$REPO" --ref main || fail "could not dispatch $WORKFLOW"

RUN_ID=""
DISCOVERY_DEADLINE="$(deadline_after 600)"
until [ -n "$RUN_ID" ] || deadline_passed "$DISCOVERY_DEADLINE"; do
  sleep 5
  RUN_ID="$(gh_bounded run list --repo "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 10 \
    --json databaseId,createdAt \
    --jq ".[] | select(.databaseId > $PREVIOUS_RUN_ID and .createdAt >= \"$SINCE\") | .databaseId" 2>/dev/null \
    | sort -n | head -n 1 || true)"
  if ! [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then RUN_ID=""; fi
done
if [ -z "$RUN_ID" ]; then fail "could not identify the dispatched $WORKFLOW run"; fi

log "waiting for off-site backup run $RUN_ID"
RUN_DEADLINE="$(deadline_after "$WAIT_SECONDS")"
while :; do
  RUN_STATE="$(gh_bounded run view "$RUN_ID" --repo "$REPO" --json status,conclusion \
    --jq '[.status, .conclusion] | @tsv' 2>/dev/null || true)"
  IFS=$'\t' read -r RUN_STATUS RUN_CONCLUSION <<< "$RUN_STATE"
  if [ "$RUN_STATUS" = completed ]; then
    if [ "$RUN_CONCLUSION" != success ]; then fail "off-site backup run $RUN_ID ended as $RUN_CONCLUSION"; fi
    break
  fi
  if deadline_passed "$RUN_DEADLINE"; then
    # Cancelled so it stops holding dictprop-production for a backup nobody will download.
    gh_bounded run cancel "$RUN_ID" --repo "$REPO" > /dev/null 2>&1 || true
    fail "off-site backup run $RUN_ID did not finish within ${WAIT_SECONDS}s; cancelled it"
  fi
  sleep 30
done

# gh writes the whole artifact to a temporary file before unpacking it, so that goes inside the download too.
DOWNLOAD="$ROOT/.download-$RUN_ID"
DOWNLOAD_DEADLINE="$(deadline_after "$DOWNLOAD_SECONDS")"
BLOB=""
for attempt in 1 2 3; do
  remaining="$(( DOWNLOAD_DEADLINE - $(date +%s) ))"
  if [ "$remaining" -le 0 ]; then break; fi
  rm -rf "$DOWNLOAD"
  mkdir -p "$DOWNLOAD/tmp" "$DOWNLOAD/artifact"
  if TMPDIR="$DOWNLOAD/tmp" GH_CALL_TIMEOUT_SECONDS="$remaining" gh_bounded run download "$RUN_ID" --repo "$REPO" \
    -n "$ARTIFACT" -D "$DOWNLOAD/artifact"; then
    BLOB="$(find "$DOWNLOAD/artifact" -type f -name '*.dpb')"
    if [ -z "$BLOB" ] || [ "$(printf '%s\n' "$BLOB" | wc -l | tr -d ' ')" != 1 ]; then
      fail "the artifact of run $RUN_ID does not hold exactly one encrypted backup"
    fi
    break
  fi
  log "the download of run $RUN_ID's artifact failed (attempt $attempt/3)"
done
if [ -z "$BLOB" ]; then fail "could not download the artifact of run $RUN_ID within ${DOWNLOAD_SECONDS}s"; fi

log "verifying run $RUN_ID's backup, $(wc -c < "$BLOB" | tr -d ' ') encrypted bytes"
VERIFIED="$("$NODE_BIN" "$OFFLINE_DIR/bridge-crypto.mjs" verify --gunzip --key-file "$KEY_FILE" \
  --purpose "$ARTIFACT:$RUN_ID" --in "$BLOB")" || fail "the artifact of run $RUN_ID did not verify for $ARTIFACT:$RUN_ID"

# The copy goes into place first, so a kill before its sidecar is written still keeps it.
NAME="dictprop-db-$(date -u +%Y%m%dT%H%M%SZ)-$RUN_ID"
mv "$BLOB" "$ROOT/$NAME.dpb"
chmod 600 "$ROOT/$NAME.dpb"
"$NODE_BIN" - "$ROOT/$NAME.dpb" "$DOWNLOAD/sidecar.json" "$RUN_ID" "$ARTIFACT:$RUN_ID" "$VERIFIED" <<'NODE'
const { createHash } = require('node:crypto');
const { createReadStream, statSync, writeFileSync } = require('node:fs');
const [copy, sidecar, runId, purpose, verified] = process.argv.slice(2);
const hash = createHash('sha256');
createReadStream(copy).on('data', chunk => hash.update(chunk)).on('end', () => {
  writeFileSync(sidecar, `${JSON.stringify({
    version: 1,
    runId: Number(runId),
    purpose,
    createdAt: new Date().toISOString(),
    encryptedBytes: statSync(copy).size,
    sha256: hash.digest('hex'),
    plaintextBytes: JSON.parse(verified).bytes,
  }, null, 2)}\n`, { mode: 0o600 });
});
NODE
mv "$DOWNLOAD/sidecar.json" "$ROOT/$NAME.json"
rm -rf "$DOWNLOAD"
DOWNLOAD=""

# The artifact expires within a day anyway, so a cleanup that fails is only logged.
ARTIFACT_IDS="$(gh_bounded api "repos/$REPO/actions/runs/$RUN_ID/artifacts" \
  --jq ".artifacts[] | select(.name == \"$ARTIFACT\") | .id" 2>/dev/null || true)"
if [ -z "$ARTIFACT_IDS" ]; then
  log "could not find the artifact of run $RUN_ID to delete; it expires within a day"
fi
for artifact_id in $ARTIFACT_IDS; do
  if [[ "$artifact_id" =~ ^[0-9]+$ ]] \
    && gh_bounded api -X DELETE "repos/$REPO/actions/artifacts/$artifact_id" > /dev/null; then
    log "deleted artifact $artifact_id of run $RUN_ID"
  else
    log "could not delete artifact $artifact_id of run $RUN_ID; it expires within a day"
  fi
done
if gh_bounded api -X DELETE "repos/$REPO/actions/runs/$RUN_ID/logs" > /dev/null; then
  log "deleted the logs of run $RUN_ID"
else
  log "could not delete the logs of run $RUN_ID"
fi

# The newest KEEP copies stay, each with its sidecar, and nothing else does. sed reads the whole list, where head
# would close the pipe early, which pipefail could take for a failure.
COUNT="$(copies | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  copies | sed -n "1,$((COUNT - KEEP))p" | while IFS= read -r old; do
    rm -f "$old" "${old%.dpb}.json"
    log "removed the older off-site backup $(basename "$old")"
  done
fi
for sidecar in "$ROOT"/dictprop-db-*.json; do
  if [ -f "$sidecar" ] && [ ! -f "${sidecar%.json}.dpb" ]; then rm -f "$sidecar"; fi
done

SUCCEEDED=1
rm -f "$ROOT/.last-attempt"
log "off-site backup complete: $ROOT/$NAME.dpb, $(wc -c < "$ROOT/$NAME.dpb" | tr -d ' ') encrypted bytes, the newest of $KEEP kept"
