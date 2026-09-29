#!/usr/bin/env bash
# Fires real, ordinary requests through eu-data-only while provider-eu is
# healthy, and confirms every one was actually served by provider-eu --
# via provider-eu's own request log, zero leakage into provider-us/
# provider-apac's own logs, and a real jaeger trace.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" eu-only-alias-stays-in-region
