# See what a gateway actually does

Nothing is broken here. LiteLLM is up, backed by a real Postgres database,
in front of a small scripted stand-in for a model provider. This is a tour
of what the gateway actually does with a call, not a puzzle to fix.

## What is running

| Service | What it is doing |
|---|---|
| `postgres` | Backs LiteLLM's virtual keys, teams and spend tracking |
| `provider` | A scripted fake model, with two deployments (`a`, `b`), each keeping its own record of what it was asked |
| `litellm` | The gateway: two aliases, `support` and `fast`, each pointed at one of the provider's deployments |
| **view** tab | A read-only page: the provider's own record of every call, next to LiteLLM's own record of every call |

`litellm`'s admin UI always asks for a login, which labs don't do, so it is
not a tab. You talk to the gateway through `send_calls.py` instead.

## Start here

```bash
python3 -B send_calls.py support "hello gateway"
python3 -B send_calls.py fast "hello gateway"
```

Each line prints the HTTP status, which deployment actually answered, and
the token usage both the provider and LiteLLM itself recorded for that
call. Open the **view** tab and send a few more -- one row appears on each
side (the provider's log, and LiteLLM's own spend log) per call, and you can
watch them arrive as you make them.

## Try this (not graded)

`gateway/config.yaml` is what tells LiteLLM which deployment each
alias means. Right now `fast` points at deployment `b`. Change its
`api_base` so it points at the same deployment `support` already uses,
save the file, then restart `litellm` from the **Services** panel on the
left (it takes up to a minute to come back, since it re-checks its
database on every start).

Send `fast` a call again and watch the **view** tab. Nothing about `support`
changes -- only what `fast` now does changed, because you changed what the
config says `fast` means, not anything about the provider itself.

## Answer these

Three things, once you've made a `support` call and one to an alias that
doesn't exist:

1. Which deployment does the `support` alias actually route to?
2. Send `support` one call with exactly the message `hello gateway`. What
   total token count comes back?
3. Ask the gateway for an alias that isn't in the config -- `does-not-exist`
   is one that isn't -- and see what happens. What HTTP status do you get?

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "support_deployment": null,
  "support_tokens_hello": null,
  "unknown_alias_status": null
}
```

Replace each `null` with what you found: `support_deployment` is a
deployment letter, the other two are numbers.

## Checking your work

| Check | Passes when |
|---|---|
| `gateway-is-up` | LiteLLM reports ready and a `support` call succeeds |
| `answers-match-the-gateway` | Your three answers match what the gateway actually does right now, checked live, not against a fixed key |

The second check makes its own calls and reads its own results -- it never
looks at your source, and it never resets anything you were relying on. All
three questions are about `support` and about an alias that was never in
the config, so nothing you do in the "try this" section above can change
any of the right answers.
