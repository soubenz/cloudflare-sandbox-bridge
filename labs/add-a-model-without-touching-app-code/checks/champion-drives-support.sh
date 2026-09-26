#!/usr/bin/env bash
# Outcome-based: proves the running catalogue -- not the learner's source
# -- actually follows a champion move, live, with no gateway restart. See
# _harness.py for the shared setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" champion-drives-support
