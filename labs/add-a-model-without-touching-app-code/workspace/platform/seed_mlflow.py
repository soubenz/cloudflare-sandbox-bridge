#!/usr/bin/env python3
"""Given, not the learner's job: registers the catalogue's one model in
MLflow and points its "champion" alias at the starting deployment.

Runs once, against an already-running MLflow server, as the last step of
the mlflow service's own startup (see manifest.yaml). Idempotent by
design, because the platform's Restart button can re-run this against a
registry that already has state in it:

  - the registered model is created only if missing (MlflowException on a
    duplicate name is treated as success, not an error);
  - each version is matched by its "deployment" tag before creating a new
    one, so re-running this never creates duplicate versions;
  - the "champion" alias is set ONLY if it does not already exist -- if a
    learner (or a grader) already moved it, re-running this must not
    stomp that move back to the starting deployment.

Three versions are registered up front (deployments a, b and c) because in
a real catalogue the versions already exist before a promotion -- "adding
a model to the catalogue" is the alias move, not the version creation.
"support"'s LiteLLM side starts with nothing in the DB at all: the
learner's sync is what is supposed to notice "champion" points somewhere
and create the matching LiteLLM model for the first time.
"""
import os
import time

import mlflow
from mlflow.exceptions import MlflowException
from mlflow.tracking import MlflowClient

MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://127.0.0.1:8964")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
REGISTERED_MODEL = os.environ.get("REGISTERED_MODEL", "support-router")
LITELLM_MODEL_NAME = os.environ.get("LITELLM_MODEL_NAME", "support")

# deployment -> (starting alias that should point here, or None)
DEPLOYMENTS = ["a", "b", "c"]
STARTING_ALIAS_TARGET = "a"


def _api_base(deployment):
    return f"{PROVIDER_URL}/{deployment}/v1"


def ensure_registered_model(client):
    try:
        client.create_registered_model(
            REGISTERED_MODEL,
            description="Catalogue entry for the LiteLLM '%s' alias." % LITELLM_MODEL_NAME,
        )
        print(f"[seed-mlflow] created registered model {REGISTERED_MODEL!r}")
    except MlflowException as e:
        if "RESOURCE_ALREADY_EXISTS" not in str(e):
            raise
        print(f"[seed-mlflow] registered model {REGISTERED_MODEL!r} already exists")


def existing_version_for(client, deployment):
    for mv in client.search_model_versions(f"name='{REGISTERED_MODEL}'"):
        if mv.tags.get("deployment") == deployment:
            return mv.version
    return None


def ensure_version(client, deployment):
    existing = existing_version_for(client, deployment)
    if existing is not None:
        print(f"[seed-mlflow] version for deployment {deployment!r} already exists: v{existing}")
        return existing
    with mlflow.start_run(run_name=f"deployment-{deployment}") as run:
        mlflow.log_param("deployment", deployment)
        mlflow.log_param("api_base", _api_base(deployment))
        run_id = run.info.run_id
    mv = client.create_model_version(
        name=REGISTERED_MODEL,
        source=f"runs:/{run_id}/model",
        run_id=run_id,
        tags={
            "litellm_model_name": LITELLM_MODEL_NAME,
            "litellm_upstream_model": "openai/fake-model",
            "litellm_api_base": _api_base(deployment),
            "deployment": deployment,
        },
        description=f"Scripted-provider deployment {deployment!r}",
    )
    print(f"[seed-mlflow] created version v{mv.version} -> deployment {deployment!r}")
    return mv.version


def ensure_alias(client, alias, version):
    try:
        current = client.get_model_version_by_alias(REGISTERED_MODEL, alias)
        print(f"[seed-mlflow] alias {alias!r} already set -> v{current.version}, leaving it alone")
        return
    except MlflowException:
        pass
    client.set_registered_model_alias(REGISTERED_MODEL, alias, version)
    print(f"[seed-mlflow] alias {alias!r} -> v{version}")


def main():
    mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
    client = MlflowClient(tracking_uri=MLFLOW_TRACKING_URI)

    ensure_registered_model(client)
    versions = {d: ensure_version(client, d) for d in DEPLOYMENTS}
    ensure_alias(client, "champion", versions[STARTING_ALIAS_TARGET])
    # "challenger" is deliberately left unset here -- setting it is part of
    # the staged-switch exercise, done later against the running registry.
    print("[seed-mlflow] done:", versions)


if __name__ == "__main__":
    # MLflow is ready in ~8s locally, but give real margin for a slow
    # container (matches manifest.yaml's mlflow healthcheck timeout).
    ATTEMPTS = 60
    for attempt in range(ATTEMPTS):
        try:
            main()
            break
        except Exception as e:  # noqa: BLE001
            print(f"[seed-mlflow] attempt {attempt + 1}/{ATTEMPTS} failed: {e}", flush=True)
            time.sleep(1)
    else:
        raise SystemExit(f"seed_mlflow.py: giving up after {ATTEMPTS} attempts")
