#!/usr/bin/env bash
# Sourced after deadline.sh (it calls gh_bounded on REPO) by the scripts that must not act while production is in
# the wrong state: the publisher, which needs a commit deployed before its import, and the off-site backup, which
# needs production's own server script. Each function answers through its status, never through set -e, and a query
# that fails answers "can't tell", which the callers treat as a reason to wait rather than to act.
#
# A concurrency group holds one running and one pending job, and a newly queued job cancels the pending one, so
# nothing should be queued in dictprop-production while one of these workflows has a run waiting there.
PRODUCTION_WORKFLOWS="deploy.yml sentence-backfill.yml recover-production.yml offsite-backup.yml"

# production_carries SHA: 0 when production runs a commit that contains SHA, 1 when it doesn't, 2 when that can't be
# told. Production only moves forward (deploy.yml leaves a release it already contains alone, and a rollback is a
# revert commit), so a successful deployment from main whose commit contains SHA proves it. The newest five are
# checked, not only the newest: running an old deployment again also succeeds, without changing what runs.
production_carries() {
  local sha="$1" heads head relation unknown=""
  if ! heads="$(gh_bounded run list --repo "$REPO" --workflow deploy.yml --branch main --status success \
    --limit 5 --json headSha --jq '.[].headSha' 2>/dev/null)"; then
    return 2
  fi
  while IFS= read -r head; do
    if [ -z "$head" ]; then continue; fi
    if [ "$head" = "$sha" ]; then return 0; fi
    # Relative to SHA: "ahead" means the deployed commit contains it.
    if relation="$(gh_bounded api "repos/$REPO/compare/$sha...$head" --jq .status 2>/dev/null)"; then
      case "$relation" in
        ahead|identical) return 0 ;;
      esac
    else
      unknown=1
    fi
  done <<< "$heads"
  if [ -n "$unknown" ]; then return 2; fi
  return 1
}

# workflow_in_flight FILE: 0 when one of the workflow's newest ten runs has not completed (queued, in progress,
# waiting, requested or pending), 1 when none has, 2 when that can't be told.
workflow_in_flight() {
  local count
  if ! count="$(gh_bounded run list --repo "$REPO" --workflow "$1" --limit 10 --json status \
    --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null)" || ! [[ "$count" =~ ^[0-9]+$ ]]; then
    return 2
  fi
  if [ "$count" -gt 0 ]; then return 0; fi
  return 1
}

# deploy_in_flight: workflow_in_flight for the deploy workflow.
deploy_in_flight() {
  workflow_in_flight deploy.yml
}

# production_busy: 0 when a workflow with a dictprop-production job (a deploy, an import or a repair, a recovery, an
# off-site backup) has a run in flight, any of its runs counting, a read-only export among them; 2 when that can't be
# told for one of them and none is known to be in flight; 1 otherwise.
production_busy() {
  local workflow status unknown=""
  for workflow in $PRODUCTION_WORKFLOWS; do
    status=0
    workflow_in_flight "$workflow" || status=$?
    case "$status" in
      0) return 0 ;;
      1) ;;
      *) unknown=1 ;;
    esac
  done
  if [ -n "$unknown" ]; then return 2; fi
  return 1
}
