#!/usr/bin/env bash
set -euo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" old-collection-is-cleaned-up
