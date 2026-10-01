#!/usr/bin/env bash
# Sourced by the incremental runner. The cycle runs this checkout's code against production, so it runs
# only the code at vps/main, the code GitHub deployed: never an edit in progress, a local commit that was
# not pushed, or an older commit that a later push replaced.

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
# changes or HEAD is not vps/main. A clean main that is behind vps/main is fast-forwarded to it first.
# This run started from the old code, so it still returns 1 when the move changed code the cycle runs,
# and the next cycle runs the new code. A failed fetch is logged and the check uses the vps/main fetched
# last. Needs the caller's log function and deadline.sh's run_bounded.
require_vetted_checkout() {
  local changed head upstream branch output moved
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
  if [ "$head" = "$upstream" ]; then
    return 0
  fi
  if ! git merge-base --is-ancestor "$head" "$upstream"; then
    log "HEAD ${head:0:12} has commits that are not on vps/main (${upstream:0:12})"
    return 1
  fi
  # Only main follows vps/main. Another branch or a detached HEAD was checked out by hand, so it stays.
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  if [ "$branch" != main ]; then
    log "HEAD ${head:0:12} is behind vps/main (${upstream:0:12}) on ${branch:+branch }${branch:-a detached HEAD}, not on main; fast-forward it to vps/main"
    return 1
  fi
  # A local edit or untracked file in the way stops the merge before it changes anything.
  if ! output="$(git merge --ff-only --quiet refs/remotes/vps/main < /dev/null 2>&1)"; then
    log "could not fast-forward main from ${head:0:12} to vps/main (${upstream:0:12}): $(printf '%s\n' "$output" | head -n 3 | tr -s '\t' ' ' | paste -sd ' ' -); fast-forward it to vps/main"
    return 1
  fi
  moved="$(git rev-parse --verify --quiet 'HEAD^{commit}')"
  log "fast-forwarded main from ${head:0:12} to vps/main (${moved:0:12})"
  if ! git diff --quiet "$head" "$moved" -- "${VETTED_PATHS[@]}"; then
    log "the fast-forward changed code the cycle runs; the next cycle runs the updated code"
    return 1
  fi
}
