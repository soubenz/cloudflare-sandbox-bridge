# See what a gateway actually does

Nothing is broken here. LiteLLM is up, backed by Postgres, in front of a
scripted stand-in for a model provider. This is a tour, not a puzzle.

## What is running

| Service | What it is doing |
|---|---|
| `postgres` | Backs LiteLLM's spend tracking |
| `provider` | A scripted fake model with two deployments (`a`, `b`), each keeping its own record of what it was asked |
| `litellm` | The gateway, with two aliases: `support` and `fast` |
| **view** tab | The provider's record of every call, next to LiteLLM's own |

LiteLLM's admin UI needs a login, so it is not a tab. Talk to the gateway
with `send_calls.py`.

## Start here

```bash
python3 -B send_calls.py support "hello gateway"
python3 -B send_calls.py fast "hello gateway"
```

Each run prints the HTTP status, the deployment that answered and the
token usage both sides recorded. Watch the rows arrive in the **view** tab.

## Try this (not graded)

`gateway/config.yaml` maps each alias to a deployment. Point `fast` at the
deployment `support` uses, save, restart `litellm` from the **Services**
panel (about 30 seconds), then send `fast` a call again.

## Answer these

The questions are in the **Questions** tab, next to this brief. Answer them there; your answers are saved for you.

## Checking your work

| Check | Passes when |
|---|---|
| `gateway-is-up` | LiteLLM is ready and a `support` call succeeds |
| `answers-match-the-gateway` | Your answers match what the gateway does right now, checked live |

Nothing in the "try this" section can change a right answer.
