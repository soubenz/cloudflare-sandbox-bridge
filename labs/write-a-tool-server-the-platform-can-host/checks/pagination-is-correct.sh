#!/usr/bin/env bash
# Outcome-based: walks list_orders forward using its own nextCursor,
# starting from no cursor, and checks the full dataset is visited exactly
# once (no duplicates, no gaps) with no cursor left to hand back at the
# end. This is the other check the untouched skeleton is expected to
# fail. See _harness.py for the shared setup this and the other three
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" pagination-is-correct
