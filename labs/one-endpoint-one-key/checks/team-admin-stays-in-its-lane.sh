#!/usr/bin/env bash
# Outcome-based: proves billing_admin's own key can self-serve a working
# key for its own team and is refused for a foreign team and on an
# admin-only endpoint. See _harness.py for the shared setup this and the
# other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" team-admin-stays-in-its-lane
