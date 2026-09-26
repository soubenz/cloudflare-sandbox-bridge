#!/usr/bin/env bash
set -euo pipefail
python3 -B "$(dirname "$0")/_harness.py" rollback-is-fast-and-stable
