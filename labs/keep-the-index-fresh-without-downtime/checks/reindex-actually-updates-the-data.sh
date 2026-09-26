#!/usr/bin/env bash
set -euo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" reindex-actually-updates-the-data
