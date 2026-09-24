#!/usr/bin/env bash
# Chaos fixture: tears the container down under a live session so the
# recovery path (Stale*HandleError / all-services-gone -> lifecycle.recover)
# has a trigger. The API has no debug kill route by design, and a pressure
# script is the only thing that runs as root on a schedule.
#
# `kill -9 1` alone does NOT work: the kernel ignores SIGKILL sent to a PID
# namespace's init from inside that namespace, so it returns success and
# nothing happens. Escalate instead.
echo "chaos: tearing down the container" >&2

# 1. The sandbox control plane listens on :3000. Losing it is what makes
#    the SDK hand out stale handles, which is the signal recover() keys on.
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  if grep -qa 'control\|server' "/proc/$pid/cmdline" 2>/dev/null && [ "$pid" != "1" ]; then
    kill -9 "$pid" 2>/dev/null
  fi
done

# 2. Everything else we are allowed to signal (init excepted, and this
#    script along with it).
kill -9 -1 2>/dev/null
