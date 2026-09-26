#!/usr/bin/env bash
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" teams-in-budget-keep-working
