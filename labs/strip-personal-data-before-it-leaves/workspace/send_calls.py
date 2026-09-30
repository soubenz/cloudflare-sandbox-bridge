#!/usr/bin/env python3
"""Send one test message through the gateway and show what the provider
actually received.

    python3 send_calls.py english
    python3 send_calls.py spanish
    python3 send_calls.py control
    python3 send_calls.py "any text you want to try"

`english`, `spanish` and `control` are canned messages containing (or, for
`control`, deliberately not containing) a name, an email, a phone number,
an SSN and a card number -- close to, but not identical to, what the
checks themselves send. Anything else on the command line is sent as-is,
so you can try your own text.

After each call this prints the gateway's HTTP status and reply, then
fetches services/fake_provider.py's own request log and prints the most
recent entry -- exactly what "the model" saw, after your hook has already
run. If your hook is doing its job, no real name, email, phone number, SSN
or card number should ever show up there.
"""
import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")

CANNED = {
    "english": (
        "Hi, this is Taylor Reyes. My email is taylor.reyes@example.com, my "
        "phone is 415-555-0173, and my SSN is 512-33-4471. My card is "
        "4111-1111-1111-1111. Please update my account."
    ),
    "spanish": (
        "Buenas tardes, me llamo Camila Ortega Vidal, mi correo es "
        "camila.ortega@example.com y mi telefono de contacto es "
        "415-555-0184. Gracias por su ayuda."
    ),
    "control": (
        "Ticket TCK-77210: customer requested 2 units of the Nimbus Office "
        "Chair, ship to Dock 5, reference PO 55210-9. Please confirm by "
        "Monday."
    ),
}


def _post(url, body, key=None):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", "Bearer %s" % key)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: send_calls.py {english|spanish|control|<your own text>}")
    arg = " ".join(sys.argv[1:])
    content = CANNED.get(arg, arg)

    print("sending: %s\n" % content)
    status, body = _post(
        LITELLM_URL.rstrip("/") + "/chat/completions",
        {"model": "assistant", "messages": [{"role": "user", "content": content}]},
        key=LITELLM_MASTER_KEY,
    )
    print("gateway -> HTTP %s: %s\n" % (status, body[:500]))

    status, log_body = _get(PROVIDER_URL.rstrip("/") + "/log")
    if status != 200:
        print("could not read the provider's log (HTTP %s)" % status)
        return
    calls = (json.loads(log_body) or {}).get("calls") or []
    if not calls:
        print("the provider has no recorded calls yet")
        return
    last = calls[-1]["body"]
    messages = last.get("messages") or []
    received = messages[-1].get("content", "") if messages else ""
    print("the provider's own log shows it received:\n  %s" % received)


if __name__ == "__main__":
    main()
