#!/usr/bin/env bash
# Outcome-based: a missing order id, a nonsensical page_size, and an
# invalid cursor each must come back isError:true with a message that
# actually names what was wrong -- never a leaked Python/pydantic
# exception string and never a silent wrong answer (isError:false with
# garbage data). This is the check the untouched skeleton is expected to
# fail. See _harness.py for the shared setup this and the other three
# checks all read.
set -uo pipefail
exec python3 -B "$(dirname "$0")/_harness.py" errors-are-clean-not-leaky
