#!/usr/bin/env bash
# Outcome-based: reconciles a FRESH ContextForge (own process, own
# throwaway SQLite db, own copies of the three toy tool servers) with the
# learner's platform/setup.py, then calls the resulting virtual server
# with whatever client token came out. See _harness.py for the shared
# setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" bundle-reaches-exactly-its-tools
