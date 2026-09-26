#!/usr/bin/env bash
# Outcome-based: probes a FRESH copy of the learner's platform/main.py
# (own throwaway database) with a query only tenant acme has anything
# relevant to, and compares against the database's own true top-k,
# computed independently by the harness via direct SQL. See _harness.py
# for the shared setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" recall-works-within-a-tenant
