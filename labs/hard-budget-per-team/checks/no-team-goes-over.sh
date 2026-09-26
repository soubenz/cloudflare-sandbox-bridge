#!/usr/bin/env bash
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" no-team-goes-over
