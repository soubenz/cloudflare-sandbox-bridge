#!/usr/bin/env bash
# Outcome-based: probes a FRESH copy of the learner's platform/main.py
# (own throwaway database) with a query scoped to tenant globex, where
# acme has a near-duplicate document deliberately close in embedding
# space. See _harness.py for the shared setup this and the other two
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" tenant-isolation-is-real
