#!/usr/bin/env python3
"""Shared grader for build-the-ingestion-pipeline's three checks.

Never reads the learner's code. Instead it runs the learner's OWN
workspace/ingest/run.py as a subprocess, four times in a row, against:

  - the harness's own throwaway Postgres database ("grading" by default,
    dropped and recreated at the start of every grading run) on the same
    Postgres server the lab's own `postgres` service already runs -- the
    learner's own database (whatever they've been experimenting against in
    their terminal) is never touched.
  - the harness's own scratch copy of the "source documents", which this
    harness edits between phases exactly like a real content source
    changing over time: phase 1 and phase 2 are byte-identical (proves
    idempotency), phase 3 changes one document's content (proves updates
    replace), phase 4 removes a document entirely (proves deletes are
    real).

Every fact a check needs -- a row count, an id set, whether a phrase is
still findable, which doc_id a real pgvector nearest-neighbor query
returns -- is read straight out of the grading database with plain SQL,
and recorded once in results.json so all three checks can share one run's
setup, the same shared-run/lock-file shape as
labs/one-endpoint-one-key/checks/_harness.py.
"""
import hashlib
import json
import math
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")
SCRATCH_SRC = os.path.join(HERE, "scratch-source")

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can run against a local stand-in
# workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
INGEST_RUN = os.path.join(WORKSPACE_DIR, "ingest", "run.py")

# The grader's own throwaway database, on the SAME Postgres server the
# lab's postgres service runs (canonical port 5432, see
# docs/lab-authoring.md's port table) -- overridable so this harness can
# run against this lab's own local test-port block while developing it.
PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
PG_USER = os.environ.get("GRADER_PG_USER", "postgres")
GRADER_DB = os.environ.get("GRADER_DB_NAME", "grading")

SETUP_TIMEOUT_S = 60

# ---- an oracle embedding, deliberately duplicated ----------------------
# Mirrors workspace/ingest/embedding.py's algorithm exactly (EMBED_DIM=32,
# same sha256 hash-chain, same L2 normalisation). Kept as the harness's OWN
# copy rather than importing the learner's file, in keeping with "never
# reads the learner's code" -- this lets phase checks run a real pgvector
# `<=>` nearest-neighbor query (proving a chunk is actually *searchable*,
# not just present as a text row) without ever importing anything out of
# WORKSPACE_DIR.
EMBED_DIM = 32


def _oracle_embed(text):
    vec = [0.0] * EMBED_DIM
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    for i in range(EMBED_DIM):
        digest = hashlib.sha256(digest).digest()
        n = int.from_bytes(digest[:8], "big")
        vec[i] = (n / 2**64) * 2.0 - 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _vector_literal(vec):
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


# ---- fixture content: the "external content source" across 4 phases ----
# Phase 1 and phase 2 use the identical dict (V1) -- an unchanged source,
# to prove a rerun is a no-op. Phase 3 (V2) changes bravo's content only.
# Phase 4 (V3) is V2 again with charlie removed entirely.

OLD_BRAVO_MARKER = "OLD-BRAVO-MARKER-echo-relay"
NEW_BRAVO_MARKER = "NEW-BRAVO-MARKER-lagoon"
CHARLIE_MARKER = "CHARLIE-ONLY-PHRASE-driftwood"

V1 = {
    "alpha": (
        "Alpha runbook: rotating the on-call schedule.\n\n"
        "Every Monday at 09:00 the on-call rotation hands off to the next "
        "engineer on the roster. The outgoing engineer must post a summary "
        "of any open incidents before the handoff, and the incoming "
        "engineer must acknowledge it before taking the pager. If no "
        "acknowledgement lands within thirty minutes, the rotation tool "
        "escalates to the secondary on-call automatically.\n\n"
        "Incidents opened in the last twenty-four hours of a shift are the "
        "outgoing engineer's responsibility to close or hand off "
        "explicitly by name."
    ),
    "bravo": (
        "Bravo runbook: %s message retries.\n\n"
        "The echo-relay service retries a failed downstream publish up to "
        "three times, with a fixed two-second delay, before writing the "
        "message to the dead-letter queue. Nothing currently pages anyone "
        "when a message lands there -- it is checked by hand once a day.\n\n"
        "%s is the identifier this runbook uses for the service in every "
        "dashboard and alert that references it." % (OLD_BRAVO_MARKER, OLD_BRAVO_MARKER)
    ),
    "charlie": (
        "Charlie runbook: %s backup verification.\n\n"
        "Nightly backups are taken at 02:00 and copied to two separate "
        "regions. A restore is actually attempted against a scratch "
        "database once a week, and row counts of a fixed set of tables are "
        "compared against the source. A backup that fails this restore "
        "check pages the on-call engineer immediately.\n\n"
        "%s is the tag applied to every backup this pipeline produces." % (CHARLIE_MARKER, CHARLIE_MARKER)
    ),
}

V2 = dict(V1)
V2["bravo"] = (
    "Bravo runbook: %s message retries, revised policy.\n\n"
    "The echo-relay service now retries a failed downstream publish up to "
    "six times, with exponential backoff starting at one second, before "
    "writing to the dead-letter queue. Dead-letter depth crossing ten "
    "items now pages the on-call engineer automatically -- the old daily "
    "manual check has been retired entirely.\n\n"
    "%s is the identifier this runbook uses for the service in every "
    "dashboard and alert that references it, replacing the old identifier "
    "everywhere." % (NEW_BRAVO_MARKER, NEW_BRAVO_MARKER)
)

V3 = {k: v for k, v in V2.items() if k != "charlie"}


# ------------------------------------------------------------------ utils

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


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


def _psql(sql, database, capture=True, timeout=30):
    psql = _find_psql()
    cmd = [
        psql, "-h", PG_HOST, "-p", PG_PORT, "-U", PG_USER, "-d", database,
        "-v", "ON_ERROR_STOP=1", "-qtA", "-F", "\t", "-c", sql,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError("psql failed for: %s\n%s" % (sql[:200], proc.stderr))
    return proc.stdout if capture else None


def _write_source(docs):
    if os.path.isdir(SCRATCH_SRC):
        for name in os.listdir(SCRATCH_SRC):
            os.remove(os.path.join(SCRATCH_SRC, name))
    else:
        os.makedirs(SCRATCH_SRC)
    for doc_id, text in docs.items():
        with open(os.path.join(SCRATCH_SRC, doc_id + ".txt"), "w", encoding="utf-8") as f:
            f.write(text)


def _run_ingest():
    env = dict(os.environ)
    env["SOURCE_DOCS_DIR"] = SCRATCH_SRC
    env["PGHOST"] = PG_HOST
    env["PGPORT"] = PG_PORT
    env["PGUSER"] = PG_USER
    env["PGDATABASE"] = GRADER_DB
    try:
        proc = subprocess.run(
            [sys.executable, "-B", INGEST_RUN],
            env=env, capture_output=True, text=True, timeout=SETUP_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, (e.stdout or ""), "ingest/run.py did not finish within %ss" % SETUP_TIMEOUT_S


def _table_exists():
    out = _psql(
        "SELECT to_regclass('public.chunks') IS NOT NULL;", GRADER_DB,
    )
    return out.strip() == "t"


def _snapshot():
    """Every row currently in the grading store: id, doc_id, content.

    Read back as one JSON aggregate rather than tab-separated lines --
    chunk content legitimately contains embedded newlines (this lab's own
    fixture text is multi-paragraph), which would otherwise split one row
    across several output lines. Postgres's own json_agg/json_build_object
    escapes control characters per the JSON spec, so the whole result is
    always exactly one line of text regardless of what's inside `content`.
    """
    if not _table_exists():
        return {"count": 0, "ids": [], "rows": []}
    out = _psql(
        "SELECT COALESCE(json_agg(json_build_object("
        "'id', id, 'doc_id', doc_id, 'content', content) ORDER BY id"
        "), '[]')::text FROM chunks;",
        GRADER_DB,
    )
    rows = json.loads(out.strip() or "[]")
    return {"count": len(rows), "ids": sorted(r["id"] for r in rows), "rows": rows}


def _count_containing(phrase):
    if not _table_exists():
        return 0
    out = _psql(
        "SELECT count(*) FROM chunks WHERE content LIKE '%%%s%%';" % phrase.replace("'", "''"),
        GRADER_DB,
    )
    return int(out.strip() or "0")


def _count_doc(doc_id):
    if not _table_exists():
        return 0
    out = _psql(
        "SELECT count(*) FROM chunks WHERE doc_id = '%s';" % doc_id.replace("'", "''"),
        GRADER_DB,
    )
    return int(out.strip() or "0")


def _nearest_doc_for(query_text):
    """doc_id of the single nearest chunk to a real pgvector `<=>` query
    against the oracle embedding of `query_text` -- a real similarity
    search against the running store, not a text match."""
    if not _table_exists():
        return None
    vec = _vector_literal(_oracle_embed(query_text))
    out = _psql(
        "SELECT doc_id FROM chunks ORDER BY embedding <=> '%s'::vector LIMIT 1;" % vec,
        GRADER_DB,
    )
    line = out.strip()
    return line or None


def _find_content_containing(rows, marker):
    """The exact, byte-for-byte content of the first stored chunk that
    contains `marker` -- used to build a similarity-search probe from a
    chunk that is actually known to be in the store, rather than a
    hand-written paraphrase that this lab's hash-based pseudo-embedding
    (no notion of semantic closeness) would place nowhere near it."""
    for row in rows:
        if marker in row["content"]:
            return row["content"]
    return None


# ------------------------------------------------------------- the setup

def _recreate_grading_db():
    rc_out = _psql("DROP DATABASE IF EXISTS %s;" % GRADER_DB, "postgres", capture=False)
    _psql("CREATE DATABASE %s;" % GRADER_DB, "postgres", capture=False)


def _build_results():
    results = {"setup_error": None}
    try:
        _recreate_grading_db()

        # --- phase 1: initial ingest ---
        _write_source(V1)
        rc, out, err = _run_ingest()
        results["phase1_returncode"] = rc
        results["phase1_stderr_tail"] = (err or "")[-2000:]
        if rc != 0:
            results["setup_error"] = (
                "workspace/ingest/run.py exited non-zero on its very first "
                "run (against an unchanged, freshly-seeded source "
                "directory): %s" % ((err or out or "")[-500:])
            )
            return results
        results["phase1"] = _snapshot()

        # --- phase 2: rerun, unchanged source ---
        rc, out, err = _run_ingest()
        results["phase2_returncode"] = rc
        results["phase2_stderr_tail"] = (err or "")[-2000:]
        if rc != 0:
            results["setup_error"] = (
                "workspace/ingest/run.py exited non-zero on its second run "
                "(same, unchanged source directory): %s" % ((err or out or "")[-500:])
            )
            return results
        results["phase2"] = _snapshot()

        # --- phase 3: bravo's content changes ---
        results["phase3_old_marker_before"] = _count_containing(OLD_BRAVO_MARKER)
        results["phase3_charlie_before"] = _count_doc("charlie")
        _write_source(V2)
        rc, out, err = _run_ingest()
        results["phase3_returncode"] = rc
        results["phase3_stderr_tail"] = (err or "")[-2000:]
        if rc != 0:
            results["setup_error"] = (
                "workspace/ingest/run.py exited non-zero after one source "
                "document's content changed: %s" % ((err or out or "")[-500:])
            )
            return results
        results["phase3"] = _snapshot()
        results["phase3_old_marker_count"] = _count_containing(OLD_BRAVO_MARKER)
        results["phase3_new_marker_count"] = _count_containing(NEW_BRAVO_MARKER)
        # Probe with the EXACT content of a chunk the store itself reports
        # for bravo's new text (not a hand-written paraphrase) -- this
        # lab's pseudo-embedding is a whole-string hash with no notion of
        # semantic closeness, so only an exact, known-stored string is a
        # meaningful nearest-neighbor probe.
        new_bravo_chunk = _find_content_containing(results["phase3"]["rows"], NEW_BRAVO_MARKER)
        results["phase3_nearest_doc_for_new_bravo"] = (
            _nearest_doc_for(new_bravo_chunk) if new_bravo_chunk else None
        )

        # --- phase 4: charlie is removed entirely ---
        results["phase4_charlie_before"] = _count_doc("charlie")
        results["phase4_charlie_phrase_before"] = _count_containing(CHARLIE_MARKER)
        charlie_chunk = _find_content_containing(results["phase3"]["rows"], CHARLIE_MARKER)
        results["phase4_nearest_doc_for_charlie_before"] = (
            _nearest_doc_for(charlie_chunk) if charlie_chunk else None
        )
        _write_source(V3)
        rc, out, err = _run_ingest()
        results["phase4_returncode"] = rc
        results["phase4_stderr_tail"] = (err or "")[-2000:]
        if rc != 0:
            results["setup_error"] = (
                "workspace/ingest/run.py exited non-zero after a source "
                "document was removed entirely: %s" % ((err or out or "")[-500:])
            )
            return results
        results["phase4"] = _snapshot()
        results["phase4_charlie_after"] = _count_doc("charlie")
        results["phase4_charlie_phrase_after"] = _count_containing(CHARLIE_MARKER)
        results["phase4_nearest_doc_for_charlie_after"] = (
            _nearest_doc_for(charlie_chunk) if charlie_chunk else None
        )

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
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

    deadline = time.time() + 4 * SETUP_TIMEOUT_S + 60
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_rerun_is_idempotent():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    p1, p2 = r.get("phase1") or {}, r.get("phase2") or {}
    if p1.get("count", 0) == 0:
        _finish(False, "the first ingestion run left no rows in the store at all")
    if p2.get("count") != p1.get("count"):
        _finish(
            False,
            "re-running ingestion against an UNCHANGED source directory changed the "
            "row count from %s to %s -- a rerun must be a no-op, not a duplicate "
            "insert" % (p1.get("count"), p2.get("count")),
        )
    if p1.get("ids") != p2.get("ids"):
        only_new = sorted(set(p2.get("ids") or []) - set(p1.get("ids") or []))
        _finish(
            False,
            "re-running ingestion against an UNCHANGED source directory produced "
            "different row ids than the first run (e.g. %s) -- chunk ids must be a "
            "stable function of the chunk's own content, not something that changes "
            "every run" % (only_new[:3] or "a different id set"),
        )
    _finish(
        True,
        "re-running ingestion against an unchanged source left exactly the same %d "
        "row(s), under exactly the same ids, as the first run" % p1.get("count", 0),
    )


def check_updates_replace_not_append():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    before = r.get("phase3_old_marker_before", 0)
    if before < 1:
        _finish(False, "grading-infrastructure problem: the OLD bravo content was never even ingested in phase 1")

    old_count = r.get("phase3_old_marker_count")
    new_count = r.get("phase3_new_marker_count")
    if old_count != 0:
        _finish(
            False,
            "after bravo's document content changed and ingestion was re-run, the "
            "OLD content is still in the store (%d matching row(s)) -- an update "
            "must remove the chunks of what a document used to say, not just add "
            "chunks for what it says now" % old_count,
        )
    if not new_count:
        _finish(
            False,
            "after bravo's document content changed and ingestion was re-run, the "
            "NEW content is nowhere in the store",
        )
    nearest = r.get("phase3_nearest_doc_for_new_bravo")
    if nearest != "bravo":
        _finish(
            False,
            "a real pgvector nearest-neighbor search for bravo's new content "
            "returned doc_id=%r as the closest chunk, not bravo -- the new content "
            "isn't actually searchable" % nearest,
        )
    _finish(
        True,
        "bravo's old content (%d matches) is gone, its new content (%d matches) is "
        "present, and a real vector similarity search for the new content finds "
        "bravo as the nearest chunk" % (0, new_count),
    )


def check_deletes_are_real():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    before_rows = r.get("phase4_charlie_before", 0)
    before_phrase = r.get("phase4_charlie_phrase_before", 0)
    before_nearest = r.get("phase4_nearest_doc_for_charlie_before")
    if before_rows < 1 or before_phrase < 1 or before_nearest != "charlie":
        _finish(
            False,
            "grading-infrastructure problem: charlie was never actually present and "
            "searchable in the store before it was removed",
        )

    after_rows = r.get("phase4_charlie_after")
    after_phrase = r.get("phase4_charlie_phrase_after")
    after_nearest = r.get("phase4_nearest_doc_for_charlie_after")

    if after_rows != 0:
        _finish(
            False,
            "charlie's source file was removed and ingestion was re-run, but %d "
            "row(s) for doc_id=charlie are still in the store" % after_rows,
        )
    if after_phrase != 0:
        _finish(
            False,
            "charlie's source file was removed, but its content is still findable "
            "in the store (%d matching row(s))" % after_phrase,
        )
    if after_nearest == "charlie":
        _finish(
            False,
            "a real pgvector nearest-neighbor search that used to return charlie "
            "still returns charlie as the closest chunk, even though its source "
            "document was removed",
        )
    _finish(
        True,
        "charlie was reachable (present, phrase-searchable, and the nearest-neighbor "
        "match) before its source file was removed, and after removal + a rerun it "
        "has zero rows, is not phrase-searchable, and is no longer returned by the "
        "same similarity search",
    )


COMMANDS = {
    "rerun-is-idempotent": check_rerun_is_idempotent,
    "updates-replace-not-append": check_updates_replace_not_append,
    "deletes-are-real": check_deletes_are_real,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
