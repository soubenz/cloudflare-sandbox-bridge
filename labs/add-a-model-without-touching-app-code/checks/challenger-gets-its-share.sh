#!/usr/bin/env bash
# Outcome-based: proves a staged rollout actually splits real traffic by
# weight, and that ending it returns traffic to a single deployment. See
# _harness.py for the shared setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" challenger-gets-its-share
