# Onboard yourself the way a new team sees it

Nothing is broken here. This is a tour of the platform's own onboarding
path, not a puzzle to fix. Play a brand new team joining today: before it
can make one real call, it needs a scoped key on the gateway and a working
tool on the tool-calling side, and nothing here does that for you.

## What is running

| Service | What it is doing |
|---|---|
| `litellm` | The gateway. One team, `platform-core`, already exists, scoped to the `legacy-writer` alias only. The second alias in `gateway/config.yaml`, `fast-draft`, is not granted to anyone yet. |
| `contextforge` | The tool-calling side. One tool server, `calculator-tools`, is already registered and exposed through a virtual server, `legacy-tools`. The other toy tool server this lab runs, `weather-tools`, is not registered with anything yet. |
| **view** tab | A read-only page: LiteLLM's teams, keys and model aliases on the left, ContextForge's registered tool servers, discovered tools and virtual servers on the right. Open it now, before you run anything, and again after. |

Neither gateway's own admin UI is a tab here -- both always ask for a
login, one way or another, so `view` stands in for both.

## What a new team actually has to do

1. Get a LiteLLM key scoped to exactly the alias it was granted (`fast-draft`), not the whole gateway.
2. Register its own tool server with ContextForge (`weather-tools`).
3. Expose that tool through a virtual server of its own.
4. Make one real call that uses both: an LLM call through the new key, then a tool call through the new tool access.

`onboard.py` does all of this for real, against the live services above --
it is not a stub. Run it whole, or one step at a time:

```bash
python3 -B onboard.py            # every step, in order, timed
python3 -B onboard.py --step 3   # just one step
python3 -B onboard.py --status   # what's already been done, no calls
```

Read what it prints. Each step reports a wall-clock timestamp and how long
it actually took. Open the view tab again afterwards: `new-team`, its key,
`weather-tools`, and `new-team-tools` should all be there now.

## Answer these

1. **How many separate systems does this onboarding path actually touch,
   end to end** -- getting a key, registering a tool, exposing it, and
   making the real call? Count the distinct platform components you had
   to talk to (not the number of API calls -- the number of different
   systems).
2. **Can the new team's key reach `legacy-writer`** -- the alias
   `platform-core` already had, that nobody ever granted to `new-team`?
   Try it (`onboard.py`'s last step already does, and prints the HTTP
   status it got back) -- is the answer yes or no?
3. **Did the real end-to-end call -- the LLM call through the new key,
   followed by the tool call through the new tool access -- actually
   succeed?**

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "systems_touched_end_to_end": null,
  "new_key_reaches_legacy_alias": null,
  "end_to_end_call_succeeded": null
}
```

Replace each `null`: the first with a number, the other two with `true` or
`false`.

## Checking your work

| Check | Passes when |
|---|---|
| `stack-is-up` | LiteLLM and ContextForge both report healthy, the pre-existing `platform-core` team and `legacy-tools` server are in place, and a real onboarding-shaped call (new key, new tool) succeeds end to end |
| `answers-match-the-live-onboarding` | Your three answers match what actually happens when the same onboarding sequence is run live, right now |

The second check never reads `onboard.py` or trusts anything it already
printed for you -- it runs the same sequence itself, under its own names,
against the same live LiteLLM and ContextForge, and reads the real
results back. It does not depend on you having run `onboard.py` at all, or
on what you renamed anything to.
