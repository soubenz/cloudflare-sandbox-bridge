# Add a model to the catalogue without touching app code

`app` is a small internal service. It calls one thing, over and over,
forever: the gateway's `support` alias. Right now every one of those
calls fails -- `support` isn't in the gateway's catalogue yet.

The catalogue entry that alias should serve already exists, versioned,
in the model registry -- it's just not wired up. Wire it up, and then
keep it wired up: when the registry's record of "which version is
current" moves, `support` has to move with it, live, with the gateway
never restarted and `services/app.py` never edited.

## What is running

| Tab / service | What it is |
|---|---|
| `mlflow` | The model registry. One registered model, three versions, an alias called `champion` pointing at the current one |
| `app` | The one thing you must not change. Calls `support` on a loop and shows which deployment answered, on its own page and at `/log` |
| `litellm` | The gateway. No UI tab -- its admin API always asks for a login. Talk to it at `$LITELLM_URL` with `$LITELLM_MASTER_KEY` |
| `sync` | Yours. `platform/sync.py`, run from `/workspace`. Left alone, it does nothing useful |

`postgres` and `provider` (a scripted stand-in for a real model backend)
also run, with nothing for you to do to either of them directly.

## The task

Build `platform/sync.py` so that the registry's `champion` alias becomes
the one place that decides which upstream deployment `support` reaches.
Read its module docstring first -- it says exactly what has to be true
when you're done, including two things worth knowing before you start
that are easy to lose an hour to otherwise.

Once it's ready, run it and leave it running: the console's Services
panel has a Restart button on the `sync` entry, next to the ones for
every other service here, and that's how you pick up a new version of
your own file. It has no page of its own and needs no login -- there's
nothing to open for it, only to restart.

After the basic wiring works, the same registry supports two more things
your sync should handle, described in the same docstring:

- a **staged rollout**, where a second version takes a deliberate slice
  of real traffic alongside the current one, rather than an all-or-
  nothing cutover;
- a **team that must never move**, no matter what the rest of the
  catalogue does -- that part is already set up for you; your only job is
  to leave it alone.

## Checking your work

Three checks, run in order, each against their own private copy of the
gateway and the registry (never the ones your terminal talks to):

- does a change to the registry's current version show up in real
  traffic quickly, with the gateway never restarted;
- does a staged rollout actually split real traffic, and does ending it
  return traffic to a single version;
- does the pinned team's traffic ever move, at any point in the above.
