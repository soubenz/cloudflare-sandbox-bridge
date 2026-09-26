#!/usr/bin/env bash
# Part 1 placeholder check: proves the stack genuinely boots and serves --
# the app is healthy (real DB connectivity), Phoenix itself is healthy, the
# phoenix-view proxy (the ui: true tab) is healthy, and a real query through
# the app returns real, distinct results. Part 2 replaces/extends this with
# checks that compare the learner's answers.json against what the running
# system actually reports.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" services-are-up
