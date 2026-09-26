#!/usr/bin/env bash
# Outcome-based: runs a FRESH search service (own database, own subprocess)
# against your current workspace/search/fusion.py, then checks the query
# whose right answer shares no vocabulary with it. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" vector-only-query-still-works
