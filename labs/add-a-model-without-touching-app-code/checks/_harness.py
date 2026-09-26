#!/usr/bin/env python3
"""Shared grader for add-a-model-without-touching-app-code's three checks.

Never reads platform/sync.py's source. Instead it stands up its OWN
LiteLLM (against a fresh, throwaway `grading` database) and its OWN
MLflow (a throwaway sqlite backend store, no --static-prefix -- nothing
here is ever proxied to a browser), seeds both from scratch, launches the
learner's *own* `platform/sync.py` as a background process pointed at
this private rig via env, and then drives real HTTP traffic through it:
a champion promotion, a staged (weighted) rollout, and a rollback -- while
also calling as a pinned team, throughout. The learner's own session
services (the ones their terminal, the `mlflow` tab and the `app` tab
talk to) are never touched.

That setup costs real time (two fresh servers, real migrations on the
grading database), so it happens once per check *run*, not once per
check. Check scripts are staged fresh into one shared, root-only
directory for the run and deleted afterward (docs/lab-authoring.md), so
that directory -- `$(dirname __file__)`, here -- doubles as scratch space
for exactly one run: whichever check script runs first does the setup and
probing and writes `results.json`; the others just read it. A lock file
(`results.lock`, atomic create-exclusive) keeps two checks that happened
to start at the same instant from both doing the setup. Copied from
labs/one-endpoint-one-key/checks/_harness.py's shared-run pattern.

Every probe result is a plain fact recorded once (an HTTP status, a
deployment string, a process's elapsed running time) -- the three check
scripts each apply their own pass/fail reading of the same facts, and
never re-hit the network.
"""

import contextlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can be run against a local
# stand-in workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CONFIG_PATH = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")
SYNC_PY = os.path.join(WORKSPACE_DIR, "platform", "sync.py")

# The grader's own gateway and registry -- canonical ports are LiteLLM's
# own 4100 and (picked for this lab, since MLflow has none of its own in
# docs/lab-authoring.md's port table) 8965; overridable so this harness
# can run against this lab's own local test-port block while developing
# it.
GRADER_LITELLM_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_MLFLOW_PORT = os.environ.get("GRADER_MLFLOW_PORT", "8965")
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_LITELLM_URL = "http://127.0.0.1:%s" % GRADER_LITELLM_PORT
GRADER_MLFLOW_URL = "http://127.0.0.1:%s" % GRADER_MLFLOW_PORT

PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
LEGACY_TEAM_KEY = os.environ.get("LEGACY_TEAM_KEY", "")
LEGACY_TEAM_ID = os.environ.get("LEGACY_TEAM_ID", "legacy-team")
REGISTERED_MODEL = os.environ.get("REGISTERED_MODEL", "support-router")
LITELLM_MODEL_NAME = os.environ.get("LITELLM_MODEL_NAME", "support")
PINNED_MODEL_NAME = os.environ.get("PINNED_MODEL_NAME", "support-legacy")
SYNC_POLL_INTERVAL_S = os.environ.get("SYNC_POLL_INTERVAL_S", "2")

LITELLM_READY_TIMEOUT_S = 120  # pre-migrated template; ~15-30s live, generous margin
MLFLOW_READY_TIMEOUT_S = 60  # ~8s live with the image's MLFLOW_* env vars, generous margin
BASELINE_TIMEOUT_S = 30  # first correct call, from a cold sync process
MOVE_TIMEOUT_S = 10  # the contract: a champion move must show up within this
SETTLE_S = 10  # let a poll-based sync (default 2s) converge before sampling
CHALLENGER_CALLS = 200
FINAL_CALLS = 20
CHALLENGER_SHARE_LOW = 0.10
CHALLENGER_SHARE_HIGH = 0.40
CHAMPION_SHARE_AFTER_REMOVAL_MIN = 0.90
PROBE_TIMEOUT_S = 15


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, key, body=None, base=GRADER_LITELLM_URL, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Authorization": "Bearer %s" % key},
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def _chat_deployment(key, base=GRADER_LITELLM_URL):
    """Calls LITELLM_MODEL_NAME and extracts which scripted deployment
    answered (see workspace/services/fake_provider.py / app.py: every
    reply is literally "reply from deployment <a|b|c>"). Returns
    (deployment_or_None, status, body)."""
    status, body = _http(
        "POST", "/chat/completions", key,
        {"model": LITELLM_MODEL_NAME, "messages": [{"role": "user", "content": "grader probe"}]},
        base=base,
    )
    if status != 200 or not isinstance(body, dict):
        return None, status, body
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None, status, body
    prefix = "reply from deployment "
    if isinstance(content, str) and content.startswith(prefix):
        return content[len(prefix):], status, body
    return None, status, body


def _chat_deployment_retrying(key, base=GRADER_LITELLM_URL, attempts=3, delay=1.5):
    """Like _chat_deployment, but tolerates a single transient failure
    (a timed-out or reset connection under real container load) rather
    than treating it as the pinned team's routing being broken. Only
    retries when no deployment could be read at all -- a call that comes
    back with a real, wrong deployment is never retried away, since that
    would be a genuine pinning failure, not a network hiccup. Found live,
    26 Sep 2026: a single un-retried probe right after LiteLLM's own team
    and key creation failed once on a 0.5-vCPU container under the same
    load as the baseline poll loop and the learner's own sync process."""
    dep = status = body = None
    for i in range(attempts):
        dep, status, body = _chat_deployment(key, base=base)
        if dep is not None:
            return dep, status, body
        if i < attempts - 1:
            time.sleep(delay)
    return dep, status, body


def _wait_until_value(get_value, want, timeout, interval=0.5):
    """Polls get_value() until it returns `want` or the timeout elapses.
    Returns (achieved, elapsed_s, last_value)."""
    start = time.time()
    last = None
    while True:
        last = get_value()
        if last == want:
            return True, time.time() - start, last
        if time.time() - start >= timeout:
            return False, time.time() - start, last
        time.sleep(interval)


def _fire_concurrent_calls(key, base, n, workers=40):
    counts = Counter()

    def _one(_):
        dep, _status, _body = _chat_deployment(key, base=base)
        return dep

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for dep in ex.map(_one, range(n)):
            if dep:
                counts[dep] += 1
    return counts


def _proc_etimes(pid):
    try:
        proc = subprocess.run(["ps", "-o", "etimes=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return int(proc.stdout.strip())
    except Exception:
        return None


def _tail(path, n_bytes=4000):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - n_bytes))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _stop_proc(proc, log_f):
    if proc is None:
        return
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(pgid, signal.SIGKILL)
            proc.wait(timeout=10)
    except (ProcessLookupError, PermissionError):
        pass
    finally:
        if log_f is not None:
            try:
                log_f.close()
            except Exception:
                pass


def _find_psql():
    from shutil import which
    found = which("psql")
    if found:
        return found
    import glob
    hits = glob.glob("/usr/lib/postgresql/*/bin/psql")
    if hits:
        return sorted(hits)[-1]
    raise RuntimeError("no psql binary found on PATH or under /usr/lib/postgresql/*/bin")


def _psql(sql):
    psql = _find_psql()
    proc = subprocess.run(
        [psql, "-h", GRADER_PG_HOST, "-p", GRADER_PG_PORT, "-U", "postgres",
         "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _kill_anything_on_port(port):
    """Best-effort: kill whatever is bound to `port`, so a process a prior
    run's wrong-answer sync orphaned (found live: relaunching LiteLLM
    itself, bound to the same port, outside anything this harness tracks)
    can't block this run from binding it again. Never raises -- a clean
    port is the common case and this is only a safety net."""
    from shutil import which
    if which("fuser"):
        subprocess.run(["fuser", "-k", "-TERM", "%s/tcp" % port], capture_output=True, timeout=5)
        time.sleep(0.3)
        subprocess.run(["fuser", "-k", "-KILL", "%s/tcp" % port], capture_output=True, timeout=5)
        return
    try:
        out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return
    needle = ":%s " % port
    for line in out.splitlines():
        if needle not in line:
            continue
        for m in __import__("re").finditer(r"pid=(\d+)", line):
            try:
                os.kill(int(m.group(1)), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def _recreate_grading_db():
    # DROP before CREATE, every run -- a leftover DB from a run that never
    # got to clean up (a killed harness, a crashed container, or -- found
    # live while testing this lab -- a wrong-answer sync.py that restarts
    # LiteLLM by relaunching it as an untracked process, which then keeps
    # its own connection to `grading` open forever) must not leak state
    # into this run. WITH (FORCE) (Postgres 13+) terminates any backends
    # still connected to the target database before dropping it, so an
    # orphaned process from a prior run's misbehaving sync can't wedge
    # every run after it.
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s WITH (FORCE);" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    # From the image's pre-migrated template (images/gateway/build-pg-template.sh):
    # instant, and the grader's LiteLLM then skips its migrations.
    rc, out, err = _psql("CREATE DATABASE %s TEMPLATE litellm_template;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (
        GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME,
    )
    env["DISABLE_SCHEMA_UPDATE"] = "True"
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["litellm", "--config", CONFIG_PATH, "--port", GRADER_LITELLM_PORT, "--host", "0.0.0.0"],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so it can be killed as a unit
    )
    return proc, log_f


def _wait_ready_litellm(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/health/readiness", "", timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


def _start_grader_mlflow(log_path):
    env = dict(os.environ)
    env["MLFLOW_DISABLE_TELEMETRY"] = "1"
    env["MLFLOW_SERVER_ENABLE_JOB_EXECUTION"] = "false"
    env["MLFLOW_DISABLE_AGENT_HINT"] = "1"
    db_path = os.path.join(HERE, "grader-mlflow.db")
    artifacts_path = os.path.join(HERE, "grader-mlflow-artifacts")
    try:
        os.remove(db_path)
    except OSError:
        pass
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [
            "mlflow", "server", "--host", "127.0.0.1", "--port", GRADER_MLFLOW_PORT,
            "--backend-store-uri", "sqlite:///%s" % db_path,
            "--default-artifact-root", artifacts_path,
            "--workers", "1",
        ],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log_f


def _wait_ready_mlflow(deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(GRADER_MLFLOW_URL + "/health", timeout=3) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def _seed_grader_mlflow():
    """Registers this run's own copy of the catalogue's one model, three
    versions (deployments a/b/c), and points 'champion' at deployment a --
    a fresh copy of what platform/seed_mlflow.py does at session boot,
    against this run's own throwaway registry. Returns {deployment: version}."""
    import mlflow
    from mlflow.tracking import MlflowClient

    mlflow.set_tracking_uri(GRADER_MLFLOW_URL)
    client = MlflowClient(tracking_uri=GRADER_MLFLOW_URL)

    # mlflow's client prints a "View run/experiment at ..." banner per
    # run/version to stdout -- harmless, but noisy next to this script's
    # own single JSON result line, so it's swallowed here.
    with open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
        client.create_registered_model(REGISTERED_MODEL, description="grader's own throwaway copy")
        versions = {}
        for deployment in ("a", "b", "c"):
            with mlflow.start_run(run_name="grader-deployment-%s" % deployment) as run:
                mlflow.log_param("deployment", deployment)
                run_id = run.info.run_id
            mv = client.create_model_version(
                name=REGISTERED_MODEL,
                source="runs:/%s/model" % run_id,
                run_id=run_id,
                tags={
                    "litellm_model_name": LITELLM_MODEL_NAME,
                    "litellm_upstream_model": "openai/fake-model",
                    "litellm_api_base": "%s/%s/v1" % (PROVIDER_URL, deployment),
                    "deployment": deployment,
                },
            )
            versions[deployment] = mv.version
        client.set_registered_model_alias(REGISTERED_MODEL, "champion", versions["a"])
    return client, versions


def _seed_grader_litellm_team():
    """A fresh copy of what platform/seed_litellm.py does at session boot,
    against this run's own throwaway gateway: the pinned team + its fixed
    key. Never created by the learner's sync -- that's the whole point."""
    status, body = _http(
        "POST", "/team/new", LITELLM_MASTER_KEY,
        {
            "team_id": LEGACY_TEAM_ID,
            "team_alias": LEGACY_TEAM_ID,
            "models": [LITELLM_MODEL_NAME],
            "model_aliases": {LITELLM_MODEL_NAME: PINNED_MODEL_NAME},
        },
    )
    if status is not None and status >= 300:
        raise RuntimeError("grader /team/new failed: %s %s" % (status, body))
    status, body = _http(
        "POST", "/key/generate", LITELLM_MASTER_KEY,
        {"key": LEGACY_TEAM_KEY, "key_alias": "%s-key" % LEGACY_TEAM_ID, "team_id": LEGACY_TEAM_ID},
    )
    if status is not None and status >= 300:
        raise RuntimeError("grader /key/generate failed: %s %s" % (status, body))


def _start_sync(log_path):
    env = dict(os.environ)
    env.update({
        "MLFLOW_TRACKING_URI": GRADER_MLFLOW_URL,
        "LITELLM_URL": GRADER_LITELLM_URL,
        "LITELLM_MASTER_KEY": LITELLM_MASTER_KEY,
        "REGISTERED_MODEL": REGISTERED_MODEL,
        "LITELLM_MODEL_NAME": LITELLM_MODEL_NAME,
        "PINNED_MODEL_NAME": PINNED_MODEL_NAME,
        "SYNC_POLL_INTERVAL_S": SYNC_POLL_INTERVAL_S,
    })
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", SYNC_PY],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log_f


# ------------------------------------------------------------- the setup

def _build_results():
    results = {"setup_error": None, "legacy_observations": []}
    procs = []  # [(proc, log_f), ...], stopped in reverse order in `finally`

    def _stop_all():
        for proc, log_f in reversed(procs):
            _stop_proc(proc, log_f)

    try:
        _kill_anything_on_port(GRADER_LITELLM_PORT)
        _kill_anything_on_port(GRADER_MLFLOW_PORT)
        _recreate_grading_db()

        litellm_proc, litellm_log_f = _start_grader_litellm(os.path.join(HERE, "grader-litellm.log"))
        procs.append((litellm_proc, litellm_log_f))
        if not _wait_ready_litellm(time.time() + LITELLM_READY_TIMEOUT_S):
            results["setup_error"] = (
                "the grader's own LiteLLM never reported ready within %ss -- "
                "this is a grading-infrastructure problem, not something in your workspace"
                % LITELLM_READY_TIMEOUT_S
            )
            return results

        mlflow_proc, mlflow_log_f = _start_grader_mlflow(os.path.join(HERE, "grader-mlflow.log"))
        procs.append((mlflow_proc, mlflow_log_f))
        if not _wait_ready_mlflow(time.time() + MLFLOW_READY_TIMEOUT_S):
            results["setup_error"] = (
                "the grader's own MLflow never reported ready within %ss -- "
                "this is a grading-infrastructure problem, not something in your workspace"
                % MLFLOW_READY_TIMEOUT_S
            )
            return results

        client, versions = _seed_grader_mlflow()
        _seed_grader_litellm_team()

        litellm_pid = litellm_proc.pid
        etimes_start = _proc_etimes(litellm_pid)
        results["litellm_pid"] = litellm_pid
        results["litellm_etimes_start"] = etimes_start

        sync_proc, sync_log_f = _start_sync(os.path.join(HERE, "sync.log"))
        procs.append((sync_proc, sync_log_f))

        # --- phase 0: baseline -- champion (deployment a), before any move ---
        ok, elapsed, dep = _wait_until_value(
            lambda: _chat_deployment(LITELLM_MASTER_KEY)[0], "a", BASELINE_TIMEOUT_S,
        )
        results["baseline_ok"] = ok
        results["baseline_deployment"] = dep
        results["baseline_elapsed_s"] = elapsed

        ldep, _lstatus, _lbody = _chat_deployment_retrying(LEGACY_TEAM_KEY)
        results["legacy_observations"].append({"phase": "baseline", "deployment": ldep, "status": _lstatus, "body": str(_lbody)[:300]})

        # --- phase 1: champion move, deployment a -> c ("the new model") ---
        client.set_registered_model_alias(REGISTERED_MODEL, "champion", versions["c"])
        ok, elapsed, dep = _wait_until_value(
            lambda: _chat_deployment(LITELLM_MASTER_KEY)[0], "c", MOVE_TIMEOUT_S,
        )
        results["move_ok"] = ok
        results["move_elapsed_s"] = elapsed
        results["move_final_deployment"] = dep

        ldep, _lstatus, _lbody = _chat_deployment_retrying(LEGACY_TEAM_KEY)
        results["legacy_observations"].append({"phase": "after_move", "deployment": ldep, "status": _lstatus, "body": str(_lbody)[:300]})

        # --- phase 2: staged rollout -- challenger (deployment b) at 25% ---
        client.set_model_version_tag(REGISTERED_MODEL, versions["b"], "traffic_percent", "25")
        client.set_registered_model_alias(REGISTERED_MODEL, "challenger", versions["b"])
        time.sleep(SETTLE_S)

        counts = _fire_concurrent_calls(LITELLM_MASTER_KEY, GRADER_LITELLM_URL, CHALLENGER_CALLS)
        total = sum(counts.values())
        results["challenger_counts"] = dict(counts)
        results["challenger_calls_total"] = total
        results["challenger_share"] = (counts.get("b", 0) / total) if total else None

        ldep, _lstatus, _lbody = _chat_deployment_retrying(LEGACY_TEAM_KEY)
        results["legacy_observations"].append({"phase": "challenger_active", "deployment": ldep, "status": _lstatus, "body": str(_lbody)[:300]})

        # --- phase 3: end the rollout -- back to champion alone ---
        client.delete_registered_model_alias(REGISTERED_MODEL, "challenger")
        time.sleep(SETTLE_S)

        counts2 = _fire_concurrent_calls(LITELLM_MASTER_KEY, GRADER_LITELLM_URL, FINAL_CALLS)
        total2 = sum(counts2.values())
        results["after_removal_counts"] = dict(counts2)
        results["after_removal_champion_share"] = (counts2.get("c", 0) / total2) if total2 else None

        ldep, _lstatus, _lbody = _chat_deployment_retrying(LEGACY_TEAM_KEY)
        results["legacy_observations"].append({"phase": "after_removal", "deployment": ldep, "status": _lstatus, "body": str(_lbody)[:300]})

        # --- was the grader's own LiteLLM ever restarted, start to finish? ---
        etimes_final = _proc_etimes(litellm_pid)
        alive_final = (litellm_proc.poll() is None)
        results["litellm_etimes_final"] = etimes_final
        results["litellm_restarted"] = not (
            alive_final
            and etimes_start is not None
            and etimes_final is not None
            and etimes_final >= etimes_start  # monotonic; a restart resets this to ~0
        )

        results["sync_alive"] = (sync_proc.poll() is None)
        results["sync_log_tail"] = _tail(os.path.join(HERE, "sync.log"))

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop_all()


def get_results():
    """Returns the shared results dict, running the one-time setup if this
    is the first check script to ask for it in this run."""
    if os.path.exists(RESULTS_PATH):
        with open(RESULTS_PATH) as f:
            return json.load(f)

    got_lock = False
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        got_lock = True
    except FileExistsError:
        pass

    if got_lock:
        try:
            results = _build_results()
            tmp = RESULTS_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(results, f)
            os.rename(tmp, RESULTS_PATH)
            return results
        finally:
            try:
                os.remove(LOCK_PATH)
            except OSError:
                pass

    # Someone else is doing the setup right now -- wait for their result.
    deadline = time.time() + LITELLM_READY_TIMEOUT_S + MLFLOW_READY_TIMEOUT_S + 120
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_champion_drives_support():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    if not r.get("baseline_ok"):
        _finish(
            False,
            "calls to the catalogue's model never reflected the starting deployment "
            "within %ss of starting your sync (last seen: %r)" % (BASELINE_TIMEOUT_S, r.get("baseline_deployment")),
        )
    if r.get("litellm_restarted"):
        _finish(
            False,
            "the gateway process was restarted (or stopped responding) while the catalogue "
            "changed -- it must be updated live, never restarted",
        )
    if not r.get("move_ok"):
        _finish(
            False,
            "after moving the catalogue's model to a new deployment, calls still landed on "
            "%r after %ss (they must land on the new deployment within %ss)"
            % (r.get("move_final_deployment"), MOVE_TIMEOUT_S, MOVE_TIMEOUT_S),
        )
    _finish(
        True,
        "calls reflected the starting deployment before the move (%.1fs) and the new "
        "deployment within %.1fs of the move, with the gateway never restarted"
        % (r.get("baseline_elapsed_s", 0.0), r.get("move_elapsed_s", 0.0)),
    )


def check_challenger_gets_its_share():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    share = r.get("challenger_share")
    if share is None:
        _finish(False, "no successful calls landed anywhere while a staged rollout was active")
    if not (CHALLENGER_SHARE_LOW <= share <= CHALLENGER_SHARE_HIGH):
        _finish(
            False,
            "with a 25%% staged rollout active, %.0f%% of %d calls reached the new deployment "
            "(expected roughly %.0f-%.0f%%)"
            % (share * 100, r.get("challenger_calls_total", 0), CHALLENGER_SHARE_LOW * 100, CHALLENGER_SHARE_HIGH * 100),
        )

    after_share = r.get("after_removal_champion_share")
    if after_share is None or after_share < CHAMPION_SHARE_AFTER_REMOVAL_MIN:
        _finish(
            False,
            "after ending the staged rollout, only %.0f%% of calls returned to the one "
            "deployment left in the catalogue (expected roughly 100%%)" % ((after_share or 0.0) * 100),
        )
    _finish(
        True,
        "a 25%% staged rollout got %.0f%% of real traffic, and ending it returned %.0f%% "
        "of traffic to the remaining deployment" % (share * 100, after_share * 100),
    )


def check_pinned_team_stays_put():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    # "Stays put while the rest of the catalogue moves" presupposes the
    # rest of the catalogue actually moved -- if the catalogue's own model
    # never came up at all, there is nothing for the pinned team to have
    # stayed put against, and this check would otherwise pass vacuously.
    if not (r.get("baseline_ok") and r.get("move_ok")):
        _finish(
            False,
            "the catalogue's own model never came up correctly during this run (see "
            "champion-drives-support), so whether the pinned team stayed put could not be "
            "meaningfully checked either",
        )

    obs = r.get("legacy_observations") or []
    if len(obs) < 4:
        _finish(False, "the pinned team's key could not be probed at every phase of this run (grading-infrastructure problem)")
    bad = [o for o in obs if o.get("deployment") != "a"]
    if bad:
        first = bad[0]
        if first.get("deployment") is None:
            _finish(
                False,
                "the pinned team's key could not be reached during %r, even after retries "
                "(last status=%r body=%r) -- this could be a grading-infrastructure problem "
                "rather than something in your workspace"
                % (first.get("phase"), first.get("status"), first.get("body")),
            )
        _finish(
            False,
            "the pinned team's key reached deployment %r during %r, while the rest of the "
            "catalogue changed -- it must always reach the deployment it was pinned to"
            % (first.get("deployment"), first.get("phase")),
        )
    _finish(
        True,
        "the pinned team's key reached its original deployment at every phase of this run, "
        "including while the rest of the catalogue moved and rolled out a challenger",
    )


COMMANDS = {
    "champion-drives-support": check_champion_drives_support,
    "challenger-gets-its-share": check_challenger_gets_its_share,
    "pinned-team-stays-put": check_pinned_team_stays_put,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
