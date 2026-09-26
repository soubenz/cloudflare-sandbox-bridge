#!/usr/bin/env bash
set -euo pipefail
python3 -B "$(dirname "$0")/_harness.py" never-zero-or-two-tools-live
