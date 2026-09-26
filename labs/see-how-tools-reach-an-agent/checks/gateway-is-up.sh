#!/usr/bin/env bash
# Part 1 placeholder check: proves the stack genuinely boots and serves --
# ContextForge is healthy, both toy tool servers are registered as
# gateways, the virtual server exists, and a real tool call through it
# succeeds. Part 2 replaces/extends this with checks that compare the
# learner's answers.json against what the running gateway actually reports.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" gateway-is-up
