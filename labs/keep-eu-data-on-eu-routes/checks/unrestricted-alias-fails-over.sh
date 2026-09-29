#!/usr/bin/env bash
# During that same provider-eu outage, global-support must still keep
# answering by actually reaching another region -- proving the fix is
# specific to eu-data-only, not a platform-wide "no fallback" setting.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" unrestricted-alias-fails-over
