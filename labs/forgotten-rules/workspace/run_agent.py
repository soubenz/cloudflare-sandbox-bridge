#!/usr/bin/env python3
"""Work one support case: reply to every customer turn, in order.

    python3 run_agent.py                  # the case in $CASE_FILE
    python3 run_agent.py other-case.json

The graders run this exact command, so keep it working.
"""

import sys

from agent.worker import run

if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
