#!/usr/bin/env python3
"""Run the billing desk over a set of scripted conversations.

    python3 run_agent.py                       # the file in $TRANSCRIPT_FILE
    python3 run_agent.py other-transcripts.json

This starts the desk's own processes -- two replicas and the router in front
of them -- drives the conversations through the router, and stops them again.

The graders run this exact command, so keep it working.
"""

import sys

from agent.driver import run

if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
