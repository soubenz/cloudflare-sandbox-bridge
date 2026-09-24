#!/usr/bin/env python3
"""Run the support-reply agent over a ticket queue.

    python3 run_agent.py                  # the queue in $TICKET_QUEUE
    python3 run_agent.py other-queue.json

The graders run this exact command, so keep it working.
"""

import sys

from agent.worker import run

if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
