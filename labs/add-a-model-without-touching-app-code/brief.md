# Add a model to the catalogue without touching app code

PLACEHOLDER (part 2 fills this in). Rough shape of what's running and
what to do, for now:

## What is running

| Service | Port | What it is |
|---|---|---|
| `postgres` | 5432 | Backs LiteLLM's DB-stored models, teams and keys |
| `provider` | 8961 | A scripted fake OpenAI-compatible model with three deployments (`a`, `b`, `c`) |
| `litellm` | 4000 | The gateway. One config-file model (`support-legacy`); everything else is DB-backed |
| `mlflow` | (tab) | The model registry -- one registered model, three versions, alias `champion` |
| `app` | (tab) | The one thing you must not change. Calls alias `support` on a timer, forever |

## The task

`app` only ever calls the LiteLLM alias `support` -- and right now, that
call fails, because `support` doesn't exist in LiteLLM's catalogue yet.
MLflow's registry already has the model this catalogue entry should
serve, versioned, with an alias (`champion`) pointing at which version is
current.

Build `platform/sync.py` so that MLflow's `champion` alias becomes the
one place that decides which upstream deployment `support` reaches --
with no restart of `litellm`, and no change to `app.py`, ever. Then make
it hold up under a staged rollout (a `challenger` alias getting a small,
weighted share of traffic) and leave one team (`legacy-team`) provably
unmoved by any of it.

## Checking your work

PLACEHOLDER.
