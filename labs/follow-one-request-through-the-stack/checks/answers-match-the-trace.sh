#!/usr/bin/env bash
# Outcome-based: derives the true answer to each of the brief's three
# questions from the seeded trace as Jaeger itself reports it right now (via
# the real /api/v3/traces query API, never a hard-coded value) and compares
# them against /workspace/answers.json.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" answers-match-the-trace
