#!/usr/bin/env bash
# Outcome-based: after each rerun, the rows that belong to documents whose
# content did not change must be the very same row versions as before
# (same Postgres xmin) -- neither deleted-and-reinserted nor updated in
# place. Catches TRUNCATE + reinsert, which the other three checks cannot,
# because content-hash ids come out identical. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" unchanged-rows-are-untouched
