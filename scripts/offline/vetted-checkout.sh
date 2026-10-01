#!/usr/bin/env bash
# Sourced by the incremental runner. The cycle runs this checkout's code against production, so it runs
# only code that is committed and already on vps/main, the code GitHub deployed, never an edit in
# progress or a local commit that was not pushed.

# The tracked files a cycle executes: its scripts, the server code tsx runs for the saved-sentence
# source, the package files behind both node_modules trees (the image check loads sharp from the root
# one), and the GitHub CLI binary it calls.
VETTED_PATHS=(
  scripts/offline
  server/src server/package.json server/package-lock.json server/tsconfig.json
  package.json package-lock.json
  .gh
)

# Run from the repository root, as the cycle is. Logs why and returns 1 when VETTED_PATHS has uncommitted
# changes or HEAD is neither vps/main nor one of its ancestors. A failed fetch is logged and the check
# uses the vps/main fetched last. Needs the caller's log function and deadline.sh's run_bounded.
require_vetted_checkout() {
  local changed head upstream
  if ! changed="$(GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=no -- "${VETTED_PATHS[@]}")"; then
    log "could not read the status of this checkout"
    return 1
  fi
  if [ -n "$changed" ]; then
    log "uncommitted changes to code the cycle runs: $(printf '%s\n' "$changed" | cut -c4- | head -n 5 | paste -sd ' ' -)"
    return 1
  fi
  if ! GIT_TERMINAL_PROMPT=0 run_bounded 120 git fetch --quiet vps main < /dev/null; then
    log "could not fetch vps/main; checking against the copy fetched last"
  fi
  if ! upstream="$(git rev-parse --verify --quiet 'refs/remotes/vps/main^{commit}')"; then
    log "no fetched vps/main to check this checkout against"
    return 1
  fi
  if ! head="$(git rev-parse --verify --quiet 'HEAD^{commit}')"; then
    log "this checkout has no commit"
    return 1
  fi
  if ! git merge-base --is-ancestor "$head" "$upstream"; then
    log "HEAD ${head:0:12} has commits that are not on vps/main (${upstream:0:12})"
    return 1
  fi
}
