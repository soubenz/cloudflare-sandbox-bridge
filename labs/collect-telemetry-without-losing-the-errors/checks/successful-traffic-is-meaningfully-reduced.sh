#!/usr/bin/env bash
# The anti-cheat for the other two: reads the same shared run's successful-
# trace retention and confirms it's actually been sampled down, not just
# kept wholesale to make the error check trivially pass. See _harness.py.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" successful-traffic-is-meaningfully-reduced
