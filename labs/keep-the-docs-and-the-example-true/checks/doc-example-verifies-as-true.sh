#!/usr/bin/env bash
# Outcome-based: runs the learner's own verify_docs.py as a real subprocess
# against the gateway already running in this session, exactly as
# QUICKSTART.md describes it. See _harness.py for the shared setup this
# and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" doc-example-verifies-as-true
