#!/usr/bin/env bash
# Sends a real, known mix through the live pipeline (shared with the other
# two checks -- see _harness.py) and confirms every error trace survived.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" no-error-trace-is-ever-lost
