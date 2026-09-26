#!/usr/bin/env bash
# Outcome-based: LiteLLM must actually report ready, which only holds once
# Postgres is reachable and (on a fresh database) every migration has run.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" litellm-ready
