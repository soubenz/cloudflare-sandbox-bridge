# Keep the docs and the example true

Every team that joins the platform starts at `docs/QUICKSTART.md`. It's
short -- get a key, make a call, confirm you're scoped the way you think
you are -- and its three examples are copy-pasteable, real `curl` against
the gateway already running in this session. A new team pastes it in and it
just works.

The problem is the day it stops working. Someone renames a model alias, or
changes what a key is granted, and the doc doesn't update itself.
`docs/verify_docs.py` is supposed to notice before the next team wastes an
afternoon on instructions that used to be right -- but right now it doesn't
check anything real.

## What you have

| Where | What |
|---|---|
| `docs/QUICKSTART.md` | The onboarding doc itself. Three examples: get a key, call the gateway's default model, confirm your key is refused for the platform-only one. Don't edit it to make the lab pass -- it's already true. |
| `docs/verify_docs.py` | Supposed to pull those three examples out of the doc, run them for real, and check the real output against what the doc says. As shipped, it only checks each example is well-formed shell -- it never calls the gateway. |

`$LITELLM_URL` and `$LITELLM_MASTER_KEY` are in your environment, as for anyone following the doc.

## Your task

Make `docs/verify_docs.py` actually verify the doc: execute each of its
three examples for real against the live gateway, and check the real
response against what `QUICKSTART.md`'s own prose says will come back. Not
"is this a valid curl command" -- does the gateway still answer the way the
doc claims, right now.

Run it yourself as you go:

```bash
python3 -B docs/verify_docs.py
```

## Checking your work

**Run checks** never reads `verify_docs.py`'s source. It runs your script
as a real subprocess against the gateway that's already up. Then, through
LiteLLM's own admin API, it renames the model alias the doc depends on and
runs your script again; separately, it edits the doc's statement of what
your key is granted and runs your script against that. Both are put back
afterward.

| Check | Passes when |
|---|---|
| `doc-example-verifies-as-true` | Your script, run against the doc and the gateway exactly as they are right now, reports pass. |
| `catches-a-renamed-model-alias` | After the alias `QUICKSTART.md` calls is renamed for real, your script reports a failure that names the alias and what the doc claimed -- not a crash, not a silent pass. |
| `catches-a-wrong-key-scope` | After the doc's stated key scope is changed to something the gateway never granted, your script reports a failure naming the value the doc now states. |
| `comparison-is-not-flaky` | Run three times against the unchanged, restored doc, your script passes every time. |

The second and third checks are the ones that matter most: they stop a
script that looks like it checks something from actually checking nothing.
You need all four.
