#!/usr/bin/env bash
# Sourced by the incremental runner and most of the offline shell scripts. Every wait that holds the
# cycle lock needs an end: macOS has no timeout(1), so polling loops compare wall-clock deadlines and
# single commands run under a perl alarm. The GitHub CLI helpers those scripts share live here too.

# The GitHub CLI and the repository the offline scripts talk to. The CLI binary is kept in .tools/, which
# git ignores, relative to the repository root that the cycle and the publishers run from.
GH_BIN="${GH_BIN:-.tools/gh}"
REPO="${GITHUB_REPOSITORY:-younotafish/DictProp-VPS}"

# Prints the epoch second that is SECONDS from now.
deadline_after() {
  echo "$(( $(date +%s) + $1 ))"
}

deadline_passed() {
  [ "$(date +%s)" -ge "$1" ]
}

# The command runs in its own process group, so a timeout also stops what it started, the renderers among
# them, instead of leaving it to finish after the cycle lock is released. The model CLIs run in detached
# process groups of their own; the stage's signal handler stops them within the grace between TERM and KILL,
# RUN_BOUNDED_KILL_GRACE_SECONDS (5 unless set to a positive integer).
RUN_BOUNDED_PERL='
  use strict;
  use warnings;
  use POSIX ();
  my ($seconds, @command) = @ARGV;
  unless (defined $seconds && $seconds =~ /^[1-9][0-9]*$/ && @command) {
    print STDERR "run_bounded: usage: run_bounded SECONDS COMMAND [ARG...]\n";
    exit 2;
  }
  my $grace = ($ENV{RUN_BOUNDED_KILL_GRACE_SECONDS} // "") =~ /^[1-9][0-9]*$/ ? $ENV{RUN_BOUNDED_KILL_GRACE_SECONDS} : 5;
  my $pid = fork;
  die "run_bounded: fork failed: $!\n" unless defined $pid;
  if (!$pid) {
    no warnings "exec";
    setpgrp(0, 0);
    { exec { $command[0] } @command };
    print STDERR "run_bounded: cannot run $command[0]: $!\n";
    POSIX::_exit(127);
  }
  # Set the group from both sides so a signal sent right after fork cannot miss it.
  setpgrp($pid, $pid);
  my ($expired, $stopping) = (0, 0);
  # The group gets TERM, or the signal this process received, and KILL once the grace has passed.
  $SIG{ALRM} = sub {
    if ($expired || $stopping) {
      kill("KILL", -$pid);
      return;
    }
    $expired = 1;
    kill("TERM", -$pid);
    alarm $grace;
  };
  for my $name (qw(TERM INT HUP)) {
    $SIG{$name} = sub {
      kill($name, -$pid);
      alarm $grace unless $stopping++;
    };
  }
  alarm $seconds;
  waitpid($pid, 0);
  my $status = $?;
  alarm 0;
  # The command can exit before the processes it started, and none of them may outlive it.
  kill("KILL", -$pid) if $expired || $stopping;
  if ($expired) {
    print STDERR "run_bounded: gave up after ${seconds}s: @command\n";
    exit 124;
  }
  exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
'

# run_bounded SECONDS COMMAND [ARG...]
# Exits 124 when the limit expires, like timeout(1), and otherwise with the command's own status.
run_bounded() {
  perl -e "$RUN_BOUNDED_PERL" "$@"
}

# run_stage SECONDS COMMAND [ARG...]
# run_bounded for long stages. Bash postpones a trap until a foreground command finishes, but not while
# the wait builtin runs, so running the stage in the background lets a stop signal end the caller at
# once. A caller that traps signals should call stop_stage from its exit trap.
STAGE_PID=""
run_stage() {
  perl -e "$RUN_BOUNDED_PERL" "$@" &
  STAGE_PID="$!"
  local status=0
  wait "$STAGE_PID" || status="$?"
  STAGE_PID=""
  return "$status"
}

# Stops a running stage and everything it started, and waits for it so nothing keeps writing after the
# caller releases its lock.
stop_stage() {
  local pid="$STAGE_PID" _
  STAGE_PID=""
  if [ -z "$pid" ] || ! kill -TERM "$pid" 2>/dev/null; then return 0; fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
    sleep 1
  done
}

# gh_bounded ARG...
# A stalled GitHub API request would otherwise hang the caller while it holds the cycle lock. Standard
# input is closed because the command runs in a background process group, where a read would stop it.
gh_bounded() {
  run_bounded "${GH_CALL_TIMEOUT_SECONDS:-300}" "$GH_BIN" "$@" < /dev/null
}

# Prints the UTC time SECONDS ago in GitHub's timestamp format. Run lists are limited to runs created
# after a dispatch, starting slightly early in case the local clock runs ahead of GitHub's.
utc_timestamp_ago() {
  perl -MPOSIX=strftime -e 'print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time - $ARGV[0])), "\n"' "$1"
}

# delete_run_artifact_and_log RUN_ID ARTIFACT
# Deletes run RUN_ID's artifacts named ARTIFACT, then the run's log, saying what it did through the caller's log
# function; callers run it once they hold what they downloaded. GitHub expires an artifact within a day anyway, so a
# failure here is only logged, and the function returns 0, under set -e too.
delete_run_artifact_and_log() {
  local run_id="$1" artifact="$2" artifact_ids artifact_id
  artifact_ids="$(gh_bounded api "repos/$REPO/actions/runs/$run_id/artifacts" \
    --jq ".artifacts[] | select(.name == \"$artifact\") | .id" 2>/dev/null || true)"
  if [ -z "$artifact_ids" ]; then
    log "could not find artifact $artifact of run $run_id to delete; it expires within a day"
  fi
  for artifact_id in $artifact_ids; do
    if [[ "$artifact_id" =~ ^[0-9]+$ ]] \
      && gh_bounded api -X DELETE "repos/$REPO/actions/artifacts/$artifact_id" > /dev/null; then
      log "deleted artifact $artifact_id ($artifact) of run $run_id"
    else
      log "could not delete artifact $artifact_id of run $run_id; it expires within a day"
    fi
  done
  if gh_bounded api -X DELETE "repos/$REPO/actions/runs/$run_id/logs" > /dev/null; then
    log "deleted the logs of run $run_id"
  else
    log "could not delete the logs of run $run_id"
  fi
}

# The sweep (bridge-leftovers.mjs) deletes a publisher release idle for six hours as one a killed
# publisher left, so no publisher may wait longer than five. Caps PUBLISH_DEADLINE_SECONDS, which the
# caller has checked is a positive integer, and says so through the caller's log function.
PUBLISH_DEADLINE_MAX_SECONDS=18000
cap_publish_deadline() {
  # A value with more digits than the cap is larger, and may be too large for bash to compare.
  if [ "${#PUBLISH_DEADLINE_SECONDS}" -gt "${#PUBLISH_DEADLINE_MAX_SECONDS}" ] \
    || [ "$PUBLISH_DEADLINE_SECONDS" -gt "$PUBLISH_DEADLINE_MAX_SECONDS" ]; then
    log "PUBLISH_DEADLINE_SECONDS=$PUBLISH_DEADLINE_SECONDS would outlast the sweep, which deletes a release idle for six hours; capping it at ${PUBLISH_DEADLINE_MAX_SECONDS}s"
    PUBLISH_DEADLINE_SECONDS="$PUBLISH_DEADLINE_MAX_SECONDS"
  fi
}
