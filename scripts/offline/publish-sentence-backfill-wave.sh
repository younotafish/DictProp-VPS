#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <release-tag> <encrypted-archive> <required-deploy-sha> [poll-seconds]" >&2
  exit 2
fi

exec "$(dirname "$0")/publish-backfill-release.sh" \
  "$1" \
  "$2" \
  sentence-backfill.enc \
  import \
  "$3" \
  "${4:-300}"
