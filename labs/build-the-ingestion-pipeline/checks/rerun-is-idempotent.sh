#!/usr/bin/env bash
# Outcome-based: runs ingestion twice against an unchanged source and
# compares the store's row count and exact id set. See _harness.py for the
# shared 4-phase setup this and the other two checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" rerun-is-idempotent
