#!/usr/bin/env bash
# Forces a real outage of provider-eu and fires real requests through
# eu-data-only during it: every one must be refused, and provider-us /
# provider-apac's own request logs must show zero requests during that
# exact window.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" eu-outage-fails-closed
