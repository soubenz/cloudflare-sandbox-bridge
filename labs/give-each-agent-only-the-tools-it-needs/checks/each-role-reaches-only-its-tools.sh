#!/usr/bin/env bash
# Outcome-based: reconciles a FRESH ContextForge (own process, own
# throwaway SQLite db, own copies of the three tool servers, the
# workspace's own bootstrap_ungoverned.py re-run to reproduce the same
# broken starting state) with the learner's platform/setup.py, then calls
# every one of the 9 known tools through each role's own token. See
# _harness.py for the shared setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" each-role-reaches-only-its-tools
