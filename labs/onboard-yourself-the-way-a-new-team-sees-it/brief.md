# Onboard yourself the way a new team sees it

Nothing is broken here. Play a brand new team joining today, and walk the platform's own onboarding path for real.

## What is running

| Service | What it is doing |
|---|---|
| `litellm` | The gateway. `platform-core` already exists, scoped to the `legacy-writer` alias. `fast-draft`, the second alias in `gateway/config.yaml`, is granted to nobody yet. |
| `contextforge` | The tool side. `calculator-tools` is already registered and exposed as `legacy-tools`. `weather-tools` is not registered yet. |
| **ContextForge** tab | ContextForge's own admin pages, already signed in. Look at its gateways and virtual servers before and after you run `onboard.py`. |
| **view** tab | Read-only: LiteLLM's teams, keys and aliases on the left, ContextForge's tool servers, tools and virtual servers on the right. Open it before you run anything, and again after. |

## Run the onboarding

`onboard.py` works against the live services. It is not a stub.

```bash
python3 -B onboard.py            # every step, in order, timed
python3 -B onboard.py --step 3   # just one step
python3 -B onboard.py --status   # what has been done, no calls
```

The new team should get `fast-draft` only, and its own tool server `weather-tools` exposed through its own virtual server.

## Answer these

1. How many separate systems does this path touch, end to end? Count distinct components you talked to, not API calls.
2. Can the new team's key reach `legacy-writer`?
3. Did the real end-to-end call succeed: the model call through the new key, then the tool call through the new tool access?

Write your answers into `/workspace/answers.json`, which starts as:

```json
{
  "systems_touched_end_to_end": null,
  "new_key_reaches_legacy_alias": null,
  "end_to_end_call_succeeded": null
}
```

Replace each `null`: a number for the first, `true` or `false` for the other two.

## Checking your work

| Check | Passes when |
|---|---|
| `stack-is-up` | LiteLLM and ContextForge are healthy, `platform-core` and `legacy-tools` are in place, and an onboarding-shaped call succeeds |
| `answers-match-the-live-onboarding` | Your answers match a fresh onboarding run live right now |

The second check runs its own sequence under its own names, so it does not depend on what you ran.
