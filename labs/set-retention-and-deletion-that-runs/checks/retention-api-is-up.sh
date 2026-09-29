#!/usr/bin/env bash
# Part 1: proves the retention-api service is genuinely up before grading
# touches anything.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" retention-api-is-up
