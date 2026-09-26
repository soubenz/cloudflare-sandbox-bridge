#!/usr/bin/env python3
"""YOUR job: make MLflow's registry the source of truth for LiteLLM's
"support" model, with no LiteLLM restart and no change to app.py.

Run this yourself (it is not started for you) -- as a loop left running
in a terminal, a background process, however you like -- and keep it
running for as long as you want the catalogue to track MLflow.

What's already true when you start:
  - MLflow has a registered model (REGISTERED_MODEL) with three versions,
    one per scripted-provider deployment (a, b, c), each tagged with the
    upstream info a LiteLLM model needs: litellm_model_name,
    litellm_upstream_model, litellm_api_base, deployment.
  - Its "champion" alias already points at the version tagged deployment
    "a". Nothing else -- LiteLLM does not yet have a "support" model at
    all, so app.py's calls to it currently fail. Making that first sync
    happen is part of the job, not a special case.
  - LiteLLM is up with store_model_in_db: true (general_settings in
    workspace/gateway/config.yaml) and a real Postgres behind it, so
    /model/new and /model/update are live, no restart required.
  - A config-file model, "support-legacy", already exists in
    workspace/gateway/config.yaml and a team is pinned to it -- see
    platform/seed_litellm.py. Never create, update or delete a model
    named PINNED_MODEL_NAME; it isn't yours to touch.

What to build, in roughly the order the checks will exercise it:

 1. Alias-driven promotion. On each pass: read the "champion" alias's
    current model version and its tags, then make sure a LiteLLM model
    named LITELLM_MODEL_NAME exists in the DB with those upstream params
    -- /model/new if it doesn't exist yet, /model/update (by
    model_info.id) if it does and the target has changed. Skip the call
    entirely if nothing changed; this runs on a timer, so it has to be
    cheap and idempotent. A champion move must be picked up within
    POLL_INTERVAL_S of the alias actually moving -- not of this process
    restarting.

 2. Staged switch. A second alias, "challenger", may or may not exist.
    When it does, its model version carries a "traffic_percent" tag
    (falls back to CHALLENGER_DEFAULT_PERCENT if the tag is missing) --
    read it and run a second LiteLLM deployment under the SAME
    LITELLM_MODEL_NAME, with litellm_params.weight set to that
    percentage, while the champion deployment's weight is set to
    (100 - percentage). (LiteLLM's router does weighted random routing
    across multiple deployments sharing one model_name whenever any
    deployment sets "weight" -- see litellm/router_strategy/
    simple_shuffle.py in the installed package.) When "challenger" is
    later removed, delete that second deployment and clear the champion
    deployment's weight so it goes back to being the only one.

 3. Never touch PINNED_MODEL_NAME. The per-team allowlist is already
    live (platform/seed_litellm.py) -- your only obligation here is to
    scope every /model/* call you make to LITELLM_MODEL_NAME (and its
    challenger sibling), so that model is never created, updated or
    deleted by this script.

MLflow client reference: MlflowClient.get_model_version_by_alias(name,
alias) raises MlflowException (or mlflow.exceptions.RestException,
depending on the mlflow version installed) when the alias doesn't exist --
that's how you detect "no challenger right now" for outcome 2, and it's
not an error worth crashing the loop over.
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

    TODO: implement outcomes 1 and 2 described above. Keep it idempotent
    -- this gets called in a loop, forever.
    """
    raise NotImplementedError("sync_once: read the module docstring and build this")


def main():
    while True:
        try:
            sync_once()
        except Exception as e:  # noqa: BLE001 - a bad pass should not kill the loop
            print(f"[sync] pass failed: {e}", flush=True)
        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
