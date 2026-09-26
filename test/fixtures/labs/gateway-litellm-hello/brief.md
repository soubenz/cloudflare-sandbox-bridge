# A gateway in front of two model deployments

Nothing is broken here. LiteLLM is up, backed by a real Postgres database,
routing two aliases to a small scripted stand-in for a model provider — this
lab is a tour of how that fits together, not a puzzle.

## What is running

| Service | Port | What it is doing |
|---|---|---|
| `postgres` | 5432 | Backs LiteLLM's virtual keys, teams and spend tracking |
| `provider` | 8961 | A scripted fake OpenAI-compatible model, with two deployments (`a`, `b`) |
| `litellm` | 4000 | The gateway itself, proxying two aliases onto the two deployments |

None of these appear as tabs above the terminal: `postgres` and `provider`
have no browsable UI, and LiteLLM's admin UI always asks for a login, which
labs don't do — you talk to it directly with `curl` instead, the same way
any of your own code would.

## The thing worth understanding

`workspace/gateway/config.yaml` maps two aliases onto the scripted
provider's two deployments:

- `support` → deployment `a`, at `http://127.0.0.1:8961/a/v1`
- `fast` → deployment `b`, at `http://127.0.0.1:8961/b/v1`

A caller only ever asks LiteLLM for `support` or `fast`; LiteLLM decides
which deployment actually answers. The scripted provider tracks every call
it receives in an in-memory log, keyed by which deployment it was, so you
can see the routing happen from the outside.

## Try this

```bash
# LiteLLM is ready once /health/readiness answers, which takes a while on
# a fresh database -- it runs every migration on first boot.
curl -s "$LITELLM_URL/health/readiness"

# Clear the provider's log, then call the "support" alias.
curl -s -X POST "$PROVIDER_URL/reset"
curl -s -X POST "$LITELLM_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "support", "messages": [{"role": "user", "content": "hello gateway"}]}'

# See which deployment actually answered, and its token accounting.
curl -s "$PROVIDER_URL/log"
```

Try the same with `model: "fast"` and see deployment `b` show up in the log
instead.

## Checking your work

**Run checks** verifies the stack is genuinely serving rather than merely
running: LiteLLM reports ready, and the `support` alias actually reaches
deployment `a` with the token accounting you'd expect.

You do not have to change anything for these to pass — that is the point of
this one.
