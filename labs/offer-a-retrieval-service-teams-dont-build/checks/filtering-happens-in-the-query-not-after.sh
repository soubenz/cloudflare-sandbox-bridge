#!/usr/bin/env bash
# Outcome-based: probes a FRESH copy of the learner's platform/main.py
# (own throwaway database) with a query scoped to tenant northwind, whose
# own true top-k documents are deliberately outranked, globally, by other
# tenants' near-verbatim restatements of the same query -- the scenario a
# "fetch the global top-k, then filter by tenant" implementation gets
# wrong. See _harness.py for the shared setup this and the other two
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" filtering-happens-in-the-query-not-after
