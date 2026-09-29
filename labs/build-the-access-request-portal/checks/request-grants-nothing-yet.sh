#!/usr/bin/env bash
# Outcome-based: submits a request against a FRESH gateway + a fresh copy of
# the learner's current portal/app.py, and confirms it never approves
# itself. See _harness.py for the shared setup this and the other three
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" request-grants-nothing-yet
