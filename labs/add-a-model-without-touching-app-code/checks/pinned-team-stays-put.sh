#!/usr/bin/env bash
# Outcome-based: proves a pinned team's key never follows the catalogue's
# moves, across every phase of the run. See _harness.py for the shared
# setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" pinned-team-stays-put
