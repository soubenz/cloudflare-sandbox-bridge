#!/usr/bin/env bash
# Outcome-based: changes one document's content, re-runs ingestion, and
# confirms the OLD content is gone while the NEW content is present and
# actually findable by a real vector search. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" updates-replace-not-append
