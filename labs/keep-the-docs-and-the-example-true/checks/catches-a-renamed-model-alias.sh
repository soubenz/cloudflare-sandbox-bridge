#!/usr/bin/env bash
# The anti-cheat: renames the live `team-chat` model alias through a real
# admin-API call (POST /model/update), re-runs the learner's verify_docs.py,
# and requires a real, specific failure -- then renames it back. Proves
# verify_docs.py actually executes QUICKSTART.md's examples against the
# live gateway rather than reading its own source or the doc's text. See
# _harness.py for the shared setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" catches-a-renamed-model-alias
