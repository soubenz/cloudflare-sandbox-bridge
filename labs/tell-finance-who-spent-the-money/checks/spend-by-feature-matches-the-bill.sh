#!/usr/bin/env bash
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" spend-by-feature-matches-the-bill
