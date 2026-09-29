#!/usr/bin/env bash
# Part 3, the over-deletion catcher: reads the pass persisted by
# target-customer-fully-deleted.sh and confirms every OTHER customer's data
# in the trace store, the cache and the export/index is byte-for-byte the
# same as it was before the deletion ran.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" other-customers-are-intact
