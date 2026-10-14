#!/usr/bin/env python3
"""Send one call through the gateway, then see what happened to it.

    python3 -B send_calls.py support "hello gateway"
"""

import json
import sys

from lib.gateway_client import ask_gateway, error_message, gateway_usage, provider_last_call


def main():
    if len(sys.argv) != 3:
        print('usage: send_calls.py <alias> "<message>"', file=sys.stderr)
        sys.exit(2)
    alias, message = sys.argv[1], sys.argv[2]

    # 1. Ask the gateway, by alias. The app never names a provider.
    status, answer = ask_gateway(alias, message)
    if status != 200:
        print("HTTP status: %r" % status)
        print("LiteLLM error: %s" % error_message(answer))
        sys.exit(1)

    # 2. Ask the provider what it received: which deployment answered, and its token count.
    deployment, provider_usage = provider_last_call()

    # 3. Compare with what the gateway itself reported.
    print("HTTP status: %d" % status)
    print("Served by deployment: %s" % deployment)
    print("Provider-recorded usage: %s" % json.dumps(provider_usage))
    print("LiteLLM-reported usage: %s" % json.dumps(gateway_usage(answer)))


if __name__ == "__main__":
    main()
