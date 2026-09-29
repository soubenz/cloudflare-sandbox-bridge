# Keep the docs and the example true

Every team that joins the platform starts at the same place:
`docs/QUICKSTART.md`. It's short -- get a key, make a call, confirm you're
scoped the way you think you are -- and every one of its three examples is
copy-pasteable, real `curl` against the gateway that's already running in
this session. That's the whole point of a quickstart: a new team pastes it
in and it just works.

The problem is what happens the day it stops working. Someone renames a
model alias, or changes what a key is granted, and the doc doesn't update
itself. `docs/verify_docs.py` is supposed to be the thing that notices
before the next team wastes an afternoon on instructions that used to be
right -- but right now it doesn't actually check anything real.

## What you have

| Where | What |
|---|---|
| `docs/QUICKSTART.md` | The onboarding doc itself. Three examples: get a key, call the gateway's default model, confirm your key is refused for the platform-only one. Don't edit this to make the lab pass -- it's already true, and it should stay true without you touching it. |
| `docs/verify_docs.py` | Supposed to pull those three examples out of the doc, run them for real, and check the real output against what the doc says. As shipped, it only checks that each example is well-formed shell -- it never calls the gateway at all. |

`$LITELLM_URL` and `$LITELLM_MASTER_KEY` are both in your environment, the
same as they are for anyone following the doc.

## Your task

Make `docs/verify_docs.py` actually verify the doc: execute each of its
three examples for real against the live gateway, and check the real
response against what `QUICKSTART.md`'s own prose says will come back.
Not "does this look like a valid curl command" -- does the gateway still
answer the way the doc claims, right now.

Run it yourself as you go:

```bash
python3 -B docs/verify_docs.py
```

## Checking your work

**Run checks** never reads `verify_docs.py`'s source. It runs your script
as a real subprocess against the gateway that's already up, then -- through
LiteLLM's own admin API, the same one a platform team would actually use --
renames the model alias the doc's examples depend on, runs your script
again, and puts the alias back afterward.

| Check | Passes when |
|---|---|
| `doc-example-verifies-as-true` | Your script, run against the doc and the gateway exactly as they are right now, reports pass. |
| `catches-a-renamed-model-alias` | After the alias `QUICKSTART.md` calls is renamed for real, your script reports a failure that names the alias -- not a crash, not a silent pass. |
| `comparison-is-not-flaky` | Run three separate times against the unchanged, restored doc, your script reports pass every time. |

The second check is the one that matters most: it's what stops a script
that looks like it checks something from actually checking nothing. You
need all three.
