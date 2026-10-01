#!/usr/bin/env bash
# Deletes publisher releases idle for six hours, which a killed publisher leaves on the public
# repository with their encrypted archive, then removes failed waves idle for a week and the archives of
# published waves under each wave-state root. --dry-run lists all of it and deletes nothing.
# Every part runs even if another fails; the exit status is 1 if any did.

set -euo pipefail

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
else
  DRY_RUN=""
fi
if [ "$#" -eq 0 ]; then
  echo "Usage: $0 [--dry-run] <wave-state-root>..." >&2
  exit 2
fi

GH_BIN="${GH_BIN:-./.gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"
NODE_BIN="${NODE_BIN:-node}"
OFFLINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$OFFLINE_DIR/deadline.sh"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

status=0
if ! releases="$(gh_bounded api --paginate --slurp "repos/$REPO/releases?per_page=100")" \
  || ! stale="$(printf '%s' "$releases" | "$NODE_BIN" "$OFFLINE_DIR/bridge-leftovers.mjs" releases)"; then
  log "could not list the repository's releases; the next sweep tries again"
  status=1
else
  while IFS=$'\t' read -r tag idle_hours; do
    if [ -z "$tag" ]; then continue; fi
    if [ -n "$DRY_RUN" ]; then
      log "would delete release $tag (idle ${idle_hours} h)"
    elif gh_bounded release delete "$tag" --repo "$REPO" --yes --cleanup-tag; then
      log "deleted release $tag (idle ${idle_hours} h)"
    else
      log "could not delete release $tag; the next sweep tries again"
      status=1
    fi
  done <<< "$stale"
fi

if ! "$NODE_BIN" "$OFFLINE_DIR/bridge-leftovers.mjs" local ${DRY_RUN:+--dry-run} "$@"; then
  log "could not clear the wave-state roots"
  status=1
fi
exit "$status"
