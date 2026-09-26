#!/usr/bin/env bash
# Outcome-based: removes a source document entirely, re-runs ingestion,
# and confirms its chunks are actually gone -- not just uncounted, but
# absent from a phrase search and no longer returned by a similarity
# search that used to return it. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" deletes-are-real
