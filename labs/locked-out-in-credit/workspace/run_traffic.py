#!/usr/bin/env python3
"""Run one hour of tenant traffic through the shared relay.

    python3 run_traffic.py                  # the file in $TRAFFIC_FILE
    python3 run_traffic.py other-traffic.json

This starts the relay's own process, sends it every request in the traffic
file in order, and stops it again.

The graders run this exact command, so keep it working.
"""

import sys

from relay.driver import run

if __name__ == "__main__":
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else None))
