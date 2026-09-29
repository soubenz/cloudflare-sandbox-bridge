#!/usr/bin/env bash
# Outcome-based: approves the SAME request twice, both sequentially and as
# a genuine concurrent race between two threads, then counts teams and keys
# on LiteLLM's own admin API (never the portal's own SQLite database) to
# confirm exactly one of each exists afterward. See _harness.py for the
# shared setup this and the other three checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" approving-twice-does-not-double-provision
