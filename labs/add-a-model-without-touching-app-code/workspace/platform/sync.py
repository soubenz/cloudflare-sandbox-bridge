#!/usr/bin/env python3
"""YOUR job: make MLflow's registry the source of truth for LiteLLM's
"support" model, with no LiteLLM restart and no change to app.py.

You run this yourself -- it is not started for you as a finished thing.
The console's Services panel has a `sync` entry with a Restart button:
edit this file, hit Restart, and it runs your latest version. Left
unimplemented, it exits immediately (see sync_once() below) -- that is
expected, and the Services panel will show it stopped.

Reads its configuration entirely from the environment (below); nothing
here should be a hard-coded host, port or key, since the checks run this
exact file against a different LiteLLM and a different MLflow than the
ones in your own session.

What's already true when you start:
  - MLflow has a registered model (REGISTERED_MODEL) with three versions,
    one per scripted-provider deployment, each tagged with the upstream
    info a LiteLLM model needs: litellm_model_name, litellm_upstream_model,
    litellm_api_base, deployment. Its "champion" alias already points at
    one of them. Nothing else -- LiteLLM does not yet have a
    LITELLM_MODEL_NAME model at all, so app.py's calls to it currently
    fail. Making that first entry appear is part of the job, not a
    special case handled for you.
  - LiteLLM is up with store_model_in_db: true and a real Postgres behind
    it, so its live catalogue can be grown and changed at runtime -- look
    at what it exposes for that (its own OpenAPI schema, served bare, is
    the fastest way to find out) rather than editing gateway/config.yaml
    or restarting the process, both of which are off the table for good.
  - A config-file model, PINNED_MODEL_NAME, already exists in
    gateway/config.yaml and a team is pinned to it (platform/
    seed_litellm.py). Never create, update or delete a model by that
    name; it isn't yours to touch, ever, under any code path.

What "done" looks like, roughly in the order the checks exercise it:

 1. Whichever MLflow model version "champion" points to right now is
    where every call to LITELLM_MODEL_NAME should land -- checked and
    corrected on a running interval, not just once at startup, and
    without ever restarting LiteLLM. A champion move must be picked up
    within POLL_INTERVAL_S of the alias actually moving.

 2. A second alias, "challenger", may or may not exist. Its model version
    carries how much of LITELLM_MODEL_NAME's traffic it should take (a
    percentage tag; CHALLENGER_DEFAULT_PERCENT is the fallback if that
    tag is missing). While it exists, real calls to LITELLM_MODEL_NAME
    should split between the champion's and the challenger's deployments
    roughly in that proportion -- LiteLLM can run more than one upstream
    under a single model name; find the setting that turns that into a
    weighted split. When "challenger" goes away, all traffic goes back to
    champion alone.

 3. PINNED_MODEL_NAME is never created, updated or deleted by this
    script, under any circumstance -- not champion moves, not challenger
    moves, not a crash mid-pass.

Two things worth knowing before you start, not for lack of trying to hide
them:
  - MlflowClient.get_model_version_by_alias(name, alias) raises an
    exception (MlflowException, or mlflow.exceptions.RestException on
    some versions) when the alias doesn't exist -- that's how you detect
    "no challenger right now," and it's not a crash worth taking the
    whole loop down over.
  - If you stash your own bookkeeping in a model's extra metadata at
    creation time, don't assume a later update to that same model keeps
    your values current -- some of what you set at creation is not
    revisited by an update to the same record, even though the update
    itself succeeds and the fields that matter for routing do change.
    Track "what did I last set this to" some other way if you need it.
"""
import os
import time

MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://127.0.0.1:8964")
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
REGISTERED_MODEL = os.environ.get("REGISTERED_MODEL", "support-router")
LITELLM_MODEL_NAME = os.environ.get("LITELLM_MODEL_NAME", "support")
PINNED_MODEL_NAME = os.environ.get("PINNED_MODEL_NAME", "support-legacy")
CHALLENGER_DEFAULT_PERCENT = int(os.environ.get("CHALLENGER_DEFAULT_PERCENT", "10"))
POLL_INTERVAL_S = float(os.environ.get("SYNC_POLL_INTERVAL_S", "2"))


def sync_once():
    """One pass: bring LiteLLM's catalogue in line with MLflow's aliases.

    TODO: implement outcomes 1-3 described in the module docstring above.
    Keep it idempotent and cheap -- this gets called on a timer, forever.
    """
    raise NotImplementedError("sync_once: read the module docstring and build this")


def main():
    while True:
        try:
            sync_once()
        except NotImplementedError:
            raise  # not built yet -- let the process exit, don't loop on it
        except Exception as e:  # noqa: BLE001 - a transient bad pass should not kill the loop
            print(f"[sync] pass failed: {e}", flush=True)
        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
