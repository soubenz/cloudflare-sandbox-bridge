# Strip personal data before it reaches a model or a log

One LiteLLM gateway sits in front of a model provider (`assistant`) that
customer-support traffic goes through. People paste real customer messages
into these calls -- names, emails, phone numbers, SSNs -- and none of that
should reach the model, or show up anywhere something downstream might log
it, in the clear.

A redaction hook already runs on every call before it goes anywhere.
Right now it catches plenty. It doesn't catch everything.

## What you have

| Where | What |
|---|---|
| `gateway/config.yaml` | The gateway's one model alias, `assistant`, wired up already. |
| `gateway/hooks/pii_guard.py` | Runs before every call (see `litellm_settings.callbacks` in config.yaml). Finds and replaces personal data using Presidio, an open-source PII detection library. |
| `send_calls.py` | Sends one message through the gateway (canned English, Spanish, or free text) and shows you exactly what the provider received. |
| **view** tab | Read-only: the provider's own request log -- every call it has received, verbatim. |

Run `python3 -B send_calls.py english` and check the view tab: the name,
email, phone number and SSN are all gone, replaced with
`<ENTITY_TYPE>`-style placeholders. Now run `python3 -B send_calls.py
spanish` and look again.

## Your task

Make `pii_guard.py` redact real personal data -- names, emails, phone
numbers, SSNs -- out of every message before it leaves the gateway, no
matter what language it's written in. "Before it leaves the gateway" means
before the provider ever sees it, and before anything the gateway itself
traces or logs sees it either -- both of those read the exact same request
this hook is handed, so whatever this hook does to it in place is what
they'll both see.

At the same time, don't overcorrect. A message with no real personal data
in it -- an order number, a capitalized product name, a date -- has to
reach the provider completely intact. A hook that redacts every digit
sequence and every capitalized word "succeeds" at hiding personal data the
same way turning the gateway off would: technically true, useless in
practice, and it fails this lab's own checks.

After you change `gateway/hooks/pii_guard.py`, restart the `litellm`
service from the Services panel for the change to take effect (it's
imported once at boot, and this takes about 30 seconds).

## Checking your work

**Run checks** never reads your code. It starts its own copy of this
gateway against a fresh, empty database, points it at your current
`gateway/config.yaml` and `gateway/hooks/pii_guard.py`, and sends real
traffic at it -- then reads the provider's own request log to see what
actually arrived.

| Check | Passes when |
|---|---|
| `english-pii-never-reaches-the-model` | An English message's name, email, phone number, SSN and card number are all gone from the provider's log. |
| `spanish-pii-never-reaches-the-model` | The same, for a message written in Spanish. |
| `ordinary-content-is-not-mangled` | A message with no real personal data in it reaches the provider with its order numbers, product names and other ordinary content completely intact. |

You need all three: the first two are about actually catching personal
data regardless of what language it's written in, and the third is about
not "fixing" that by redacting everything indiscriminately.
