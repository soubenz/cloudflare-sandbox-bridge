#!/usr/bin/env python3
"""Shared grader for keep-the-index-fresh-without-downtime's three checks.

Never reads the learner's code. Instead it starts its OWN Qdrant process
against fresh, throwaway storage (a real, isolated process on its own
port -- Qdrant needs no migration and boots in well under a second, so
there is no reason to share the learner's own instance the way the
LiteLLM-based labs share a throwaway database instead of a throwaway
server), seeds it with the FIXED starting document set
(workspace/data/documents_v1.json -- a data fixture, not the graded
artifact, the same way other labs' harnesses read a fixed config.yaml or
teams.yaml directly), starts a steady stream of concurrent search queries
against a stable alias, then runs the learner's own
`workspace/reindex/reindex.py` against that fresh gateway with the updated
document set (documents_v2.json) while those queries keep firing -- exactly
the situation the lesson is about. The learner's own live Qdrant (the one
their terminal and the qdrant dashboard tab talk to) is never touched.

Every probe result is a plain fact recorded once -- the three check scripts
each apply their own pass/fail reading of the same facts, and never re-hit
the network. Check scripts are staged fresh into one shared, root-only
directory for the run and deleted afterward (docs/lab-authoring.md), so
that directory -- `$(dirname __file__)`, here -- doubles as scratch space
for exactly one run: whichever check script runs first does the setup and
probing and writes `results.json`; the others just read it. A lock file
(`results.lock`, atomic create-exclusive) keeps two checks that happened to
start at the same instant from both doing the setup.
"""
import glob
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")
STORAGE_DIR = os.path.join(HERE, "grader-qdrant-storage")
CONFIG_PATH = os.path.join(HERE, "grader-qdrant-config.yaml")
LOG_PATH = os.path.join(HERE, "grader-qdrant.log")

# The workspace root (docs/lab-authoring.md guarantees a check script's cwd
# is /workspace) -- overridable only so this same harness can be run
# against a local stand-in workspace while developing/testing the lab
# itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
REINDEX_SCRIPT = os.path.join(WORKSPACE_DIR, "reindex", "reindex.py")
DOCS_V1 = os.path.join(WORKSPACE_DIR, "data", "documents_v1.json")
DOCS_V2 = os.path.join(WORKSPACE_DIR, "data", "documents_v2.json")

# The grader's own Qdrant. Canonical port is 6333 (see docs/lab-authoring.md's
# port table); this grader always uses a different, fixed port so it never
# collides with the learner's own live instance. Overridable so this
# harness can run against this lab's own local test-port block (55000-55999)
# while developing it.
GRADER_PORT = int(os.environ.get("GRADER_QDRANT_PORT", "6433"))
GRADER_URL = "http://127.0.0.1:%d" % GRADER_PORT
QDRANT_BIN = os.environ.get("QDRANT_BIN", "qdrant")

ALIAS_NAME = "grading_live"
SEED_COLLECTION = "grading_seed"

VECTOR_DIM = 16
DISTANCE = "Cosine"

READY_TIMEOUT_S = 60
REINDEX_TIMEOUT_S = 60
PROBE_TIMEOUT_S = 10
N_QUERY_WORKERS = 8
QUERY_INTERVAL_S = 0.01
POST_RUN_QUERY_TAIL_S = 1.0


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _embed(text):
    """Independent copy of the same deterministic pseudo-embedding scheme
    workspace/reindex/embedding.py uses. Kept separate on purpose: this
    harness must never trust anything the learner's workspace could have
    changed, including the embedding function, so its own notion of "what
    vector does this text produce" cannot be satisfied by editing
    workspace files."""
    vec = []
    seed = text.encode("utf-8")
    counter = 0
    while len(vec) < VECTOR_DIM:
        digest = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for i in range(0, len(digest), 4):
            if len(vec) >= VECTOR_DIM:
                break
            raw = int.from_bytes(digest[i:i + 4], "big") / 2**32
            vec.append(raw * 2 - 1)
        counter += 1
    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]


PROBE_VECTOR = [1.0] + [0.0] * (VECTOR_DIM - 1)


def _http(method, path, body=None, base=GRADER_URL, timeout=PROBE_TIMEOUT_S):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e), time.time() - t0
    latency = time.time() - t0
    if not raw:
        return status, None, latency
    try:
        return status, json.loads(raw), latency
    except ValueError:
        return status, raw.decode("utf-8", "replace"), latency


def _find_qdrant_bin():
    found = shutil.which(QDRANT_BIN)
    if found:
        return found
    if os.path.isfile(QDRANT_BIN) and os.access(QDRANT_BIN, os.X_OK):
        return QDRANT_BIN
    hits = glob.glob("/opt/qdrant/qdrant") + glob.glob("/usr/local/bin/qdrant") + glob.glob("/usr/bin/qdrant")
    if hits:
        return hits[0]
    raise RuntimeError(
        "no qdrant binary found (looked on PATH as %r) -- this is a "
        "grading-infrastructure problem, not something in your workspace" % QDRANT_BIN
    )


# ------------------------------------------------------------- the setup

def _reset_storage():
    shutil.rmtree(STORAGE_DIR, ignore_errors=True)
    os.makedirs(STORAGE_DIR, exist_ok=True)
    config = {
        "log_level": "INFO",
        "storage": {
            "storage_path": os.path.join(STORAGE_DIR, "storage"),
            "snapshots_path": os.path.join(STORAGE_DIR, "snapshots"),
            "on_disk_payload": True,
        },
        "service": {"host": "127.0.0.1", "http_port": GRADER_PORT, "grpc_port": GRADER_PORT + 1},
        "telemetry_disabled": True,
    }
    # No YAML dependency needed -- Qdrant accepts a JSON config file, JSON
    # being a strict subset of YAML.
    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f)


def _start_grader_qdrant():
    binpath = _find_qdrant_bin()
    log_f = open(LOG_PATH, "wb")
    proc = subprocess.Popen(
        [binpath, "--config-path", CONFIG_PATH],
        stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log_f


def _stop_grader_qdrant(proc, log_f):
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
        try:
            log_f.close()
        except Exception:
            pass


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _, _ = _http("GET", "/healthz", timeout=3)
        if status == 200:
            return True
        time.sleep(0.2)
    return False


def _seed():
    with open(DOCS_V1) as f:
        docs = json.load(f)
    status, body, _ = _http("PUT", "/collections/%s" % SEED_COLLECTION, {
        "vectors": {"size": VECTOR_DIM, "distance": DISTANCE},
    })
    if status != 200:
        raise RuntimeError("seed: could not create collection: %r" % (body,))
    points = [{"id": d["id"], "vector": _embed(d["text"]), "payload": {"text": d["text"]}} for d in docs]
    status, body, _ = _http("PUT", "/collections/%s/points?wait=true" % SEED_COLLECTION, {"points": points})
    if status != 200:
        raise RuntimeError("seed: could not upsert points: %r" % (body,))
    status, body, _ = _http("POST", "/collections/aliases", {
        "actions": [{"create_alias": {"collection_name": SEED_COLLECTION, "alias_name": ALIAS_NAME}}]
    })
    if status != 200:
        raise RuntimeError("seed: could not create alias: %r" % (body,))


def _list_collections():
    status, body, _ = _http("GET", "/collections")
    if status != 200:
        return None
    return sorted(c["name"] for c in body["result"]["collections"])


def _alias_target(alias):
    status, body, _ = _http("GET", "/aliases")
    if status != 200:
        return None
    for a in body["result"]["aliases"]:
        if a["alias_name"] == alias:
            return a["collection_name"]
    return None


def _retrieve_point(alias, point_id):
    status, body, _ = _http("GET", "/collections/%s/points/%s" % (alias, point_id))
    if status != 200:
        return status, None
    return status, ((body or {}).get("result") or {}).get("payload", {}).get("text")


class _QueryRecorder:
    def __init__(self):
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.log = []
        self.threads = []

    def _worker(self):
        while not self.stop.is_set():
            status, body, latency = _http("POST", "/collections/%s/points/search" % ALIAS_NAME, {
                "vector": PROBE_VECTOR, "limit": 3, "with_payload": False,
            })
            result = body.get("result") if isinstance(body, dict) else None
            entry = {
                "t": time.time(),
                "status": status,
                "latency_ms": round(latency * 1000, 3),
                "n_hits": (len(result) if isinstance(result, list) else None),
                "error": (status != 200),
                "empty": (isinstance(result, list) and len(result) == 0),
                "body_snip": (json.dumps(body)[:200] if status != 200 else None),
            }
            with self.lock:
                self.log.append(entry)
            time.sleep(QUERY_INTERVAL_S)

    def start(self):
        for _ in range(N_QUERY_WORKERS):
            t = threading.Thread(target=self._worker, daemon=True)
            t.start()
            self.threads.append(t)

    def stop_and_join(self):
        self.stop.set()
        for t in self.threads:
            t.join(timeout=5)


def _run_reindex():
    env = dict(os.environ)
    env["QDRANT_URL"] = GRADER_URL
    env["ALIAS_NAME"] = ALIAS_NAME
    try:
        proc = subprocess.run(
            [sys.executable, "-B", REINDEX_SCRIPT, DOCS_V2],
            env=env, capture_output=True, text=True, timeout=REINDEX_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, (e.stdout or ""), "reindex.py did not finish within %ss" % REINDEX_TIMEOUT_S


def _build_results():
    results = {"setup_error": None}
    grader_proc = None
    log_f = None
    try:
        if not os.path.isfile(REINDEX_SCRIPT):
            results["setup_error"] = "workspace/reindex/reindex.py does not exist"
            return results

        _reset_storage()
        grader_proc, log_f = _start_grader_qdrant()
        try:
            if not _wait_ready(time.time() + READY_TIMEOUT_S):
                results["setup_error"] = (
                    "the grader's own Qdrant (fresh storage, port %d) never became "
                    "ready within %ss -- this is a grading-infrastructure problem, "
                    "not something in your workspace" % (GRADER_PORT, READY_TIMEOUT_S)
                )
                return results

            _seed()
            collections_before = _list_collections()
            alias_before = _alias_target(ALIAS_NAME)
            results["seed_collection"] = SEED_COLLECTION
            results["alias_before"] = alias_before
            results["collections_before"] = collections_before

            recorder = _QueryRecorder()
            recorder.start()
            time.sleep(0.5)  # let queries warm up before the reindex begins

            rc, out, err = _run_reindex()
            results["reindex_returncode"] = rc
            results["reindex_stdout"] = (out or "")[-2000:]
            results["reindex_stderr"] = (err or "")[-2000:]

            time.sleep(POST_RUN_QUERY_TAIL_S)  # keep querying a moment after, too
            recorder.stop_and_join()
            results["query_log_count"] = len(recorder.log)
            results["query_errors"] = [l for l in recorder.log if l["error"]]
            results["query_empties"] = [l for l in recorder.log if l["empty"]]

            collections_after = _list_collections()
            alias_after = _alias_target(ALIAS_NAME)
            results["collections_after"] = collections_after
            results["alias_after"] = alias_after

            status1, text1 = _retrieve_point(ALIAS_NAME, 1)
            status13, text13 = _retrieve_point(ALIAS_NAME, 13)
            results["point_1_after"] = {"status": status1, "text": text1}
            results["point_13_after"] = {"status": status13, "text": text13}

            with open(DOCS_V2) as f:
                v2_docs = {d["id"]: d["text"] for d in json.load(f)}
            results["expected_point_1_text"] = v2_docs.get(1)
            results["expected_point_13_text"] = v2_docs.get(13)

            return results
        finally:
            _stop_grader_qdrant(grader_proc, log_f)
    except Exception as e:
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results


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

    deadline = time.time() + READY_TIMEOUT_S + REINDEX_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_reindex_actually_updates_the_data():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    if r.get("reindex_returncode") != 0:
        _finish(False, "reindex.py exited with code %r; stderr: %s" % (
            r.get("reindex_returncode"), (r.get("reindex_stderr") or "")[-500:]))

    p1 = r.get("point_1_after") or {}
    p13 = r.get("point_13_after") or {}
    expected1 = r.get("expected_point_1_text")
    expected13 = r.get("expected_point_13_text")

    checks = [
        (p1.get("status") == 200, "querying the live alias for document 1 failed after reindexing"),
        (p1.get("text") == expected1,
         "document 1 still reads %r after reindexing -- it should read the updated text %r" % (
             p1.get("text"), expected1)),
        (p13.get("status") == 200, "document 13, added only in the new data, is not reachable through the live alias after reindexing"),
        (p13.get("text") == expected13,
         "document 13's content does not match what the new document set says"),
    ]
    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "querying the live alias after reindexing returns the updated content for an existing document and the content of a newly added one")


def check_zero_downtime_is_real():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    if r.get("reindex_returncode") != 0:
        _finish(False, "reindex.py did not complete successfully, so zero-downtime cannot be claimed; stderr: %s" % (
            (r.get("reindex_stderr") or "")[-500:]))

    n = r.get("query_log_count") or 0
    if n < 50:
        _finish(False, "only %d queries were recorded during the reindex window -- grading infrastructure issue, not enough traffic to judge downtime" % n)

    errors = r.get("query_errors") or []
    empties = r.get("query_empties") or []
    if errors:
        sample = errors[0]
        _finish(False, "%d of %d queries against the live alias failed during the reindex (e.g. status %s: %s) -- that is real downtime" % (
            len(errors), n, sample.get("status"), sample.get("body_snip")))
    if empties:
        _finish(False, "%d of %d queries against the live alias returned zero hits during the reindex -- that is real downtime, even though the request itself didn't error" % (
            len(empties), n))
    _finish(True, "all %d queries fired against the live alias during the reindex returned 200 with results -- no gap" % n)


def check_old_collection_is_cleaned_up():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    if r.get("reindex_returncode") != 0:
        _finish(False, "reindex.py did not complete successfully, so there is nothing to check for cleanup")

    alias_before = r.get("alias_before")
    alias_after = r.get("alias_after")
    collections_after = r.get("collections_after") or []

    if alias_after == alias_before:
        _finish(False, "the live alias still points at the same collection (%r) it did before reindexing -- no new collection was ever built" % alias_before)
    if alias_before in collections_after:
        _finish(False, "the collection that used to serve the live alias (%r) still exists after reindexing -- it was never cleaned up" % alias_before)
    _finish(True, "the live alias now points at a new collection (%r), and the old one (%r) no longer exists" % (alias_after, alias_before))


COMMANDS = {
    "reindex-actually-updates-the-data": check_reindex_actually_updates_the_data,
    "zero-downtime-is-real": check_zero_downtime_is_real,
    "old-collection-is-cleaned-up": check_old_collection_is_cleaned_up,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
