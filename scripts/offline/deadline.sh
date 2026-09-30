#!/usr/bin/env bash
# Sourced by the offline publishers and the incremental runner. Every wait that holds the cycle lock
# needs an end: macOS has no timeout(1), so polling loops compare wall-clock deadlines and single
# commands run under a perl alarm.

# Prints the epoch second that is SECONDS from now.
deadline_after() {
  echo "$(( $(date +%s) + $1 ))"
}

deadline_passed() {
  [ "$(date +%s)" -ge "$1" ]
}

# The command runs in its own process group, so a timeout also stops the renderers and model CLIs it
# started instead of leaving them to finish after the cycle lock is released.
RUN_BOUNDED_PERL='
  use strict;
  use warnings;
  use POSIX ();
  my ($seconds, @command) = @ARGV;
  unless (defined $seconds && $seconds =~ /^[1-9][0-9]*$/ && @command) {
    print STDERR "run_bounded: usage: run_bounded SECONDS COMMAND [ARG...]\n";
    exit 2;
  }
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
  # The group gets TERM, or the signal this process received, and KILL five seconds later.
  $SIG{ALRM} = sub {
    if ($expired || $stopping) {
      kill("KILL", -$pid);
      return;
    }
    $expired = 1;
    kill("TERM", -$pid);
    alarm 5;
  };
  for my $name (qw(TERM INT HUP)) {
    $SIG{$name} = sub {
      kill($name, -$pid);
      alarm 5 unless $stopping++;
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
  run_bounded "${GH_CALL_TIMEOUT_SECONDS:-300}" "${GH_BIN:-./.gh}" "$@" < /dev/null
}

# Prints the UTC time SECONDS ago in GitHub's timestamp format. Run lists are limited to runs created
# after a dispatch, starting slightly early in case the local clock runs ahead of GitHub's.
utc_timestamp_ago() {
  perl -MPOSIX=strftime -e 'print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time - $ARGV[0])), "\n"' "$1"
}
