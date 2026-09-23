#!/usr/bin/env bash
# Chaos fixture: kills the container's init process so the platform
# replaces the container under a live session. Exercises the recovery
# path (Stale*HandleError -> lifecycle.recover) and risk R8 from the
# plan, which otherwise has no trigger — there is deliberately no debug
# kill route on the API.
echo "killing pid 1" >&2
kill -9 1 || kill -9 -1
