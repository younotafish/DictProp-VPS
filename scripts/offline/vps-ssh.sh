#!/usr/bin/env bash

# Runs one script on the VPS from a GitHub runner over OpenSSH that trusts only the host keys pinned
# in VPS_KNOWN_HOSTS, so an impostor host ends the connection before anything is sent. Standard input
# and output pass straight through, which is how bridge bundles travel without a copy in the log.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <remote-script>" >&2
  exit 2
fi
: "${VPS_SSH_KEY:?VPS_SSH_KEY is required}"
: "${VPS_KNOWN_HOSTS:?VPS_KNOWN_HOSTS is required}"

SSH_DIR="$(umask 077 && mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vps-ssh.XXXXXX")"
trap 'rm -rf "$SSH_DIR"' EXIT
(
  umask 077
  printf '%s\n' "$VPS_SSH_KEY" > "$SSH_DIR/key"
  printf '%s\n' "$VPS_KNOWN_HOSTS" > "$SSH_DIR/known_hosts"
)

# -F /dev/null keeps any ssh_config on the runner from changing the host, the keys or the checks.
ssh -F /dev/null -i "$SSH_DIR/key" \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$SSH_DIR/known_hosts" -o GlobalKnownHostsFile=/dev/null \
  -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 \
  root@107.152.47.101 "$1"
