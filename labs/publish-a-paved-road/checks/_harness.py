#!/usr/bin/env python3
"""Shared grader for this lab's three checks.

Never reads workspace/template/app.py's source. Instead it fires real HTTP
requests straight through the ALREADY-RUNNING services this session's own
terminal, the fault proxy, litellm and Jaeger are all the exact same ones a
learner is looking at -- and reads back what those services actually did:

  1. one normal call to the template's own POST /answer, then a poll of the
     ALREADY-RUNNING Jaeger for the trace id that response carries;
  2. one call to POST /answer made while the fault proxy (in front of the
     provider `feature-model` reaches) is in `slow` mode -- a real 30s hang
     on the far end -- timing how long the template itself takes to answer;
  3. the credential workspace/gateway/seed_key.py minted for the template
     service, read from credentials.json and probed directly against
     litellm's own GET /key/info and a real chat-completions call against
     both `feature-model` and the decoy `other-team-model` alias.

Check scripts are staged fresh into one shared, root-only directory per run
and deleted afterward (docs/lab-authoring.md), so that directory --
`$(dirname __file__)`, here -- doubles as scratch space for exactly one
run: whichever check script runs first does all three probes and writes
`results.json`; the other two just read it. A lock file (`results.lock`,
atomic create-exclusive) keeps two checks that happen to start at the same
instant from both doing the work.

Every fact is recorded once -- the three check functions each apply their
own pass/fail reading of the same recorded facts, never re-firing a request.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CREDENTIALS_FILE = os.environ.get("CREDENTIALS_FILE", os.path.join(WORKSPACE_DIR, "template", "credentials.json"))

TEMPLATE_URL = os.environ.get("TEMPLATE_URL", "http://127.0.0.1:8980").rstrip("/")
FAULT_PROXY_URL = os.environ.get("FAULT_PROXY_URL", "http://127.0.0.1:8973").rstrip("/")
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
JAEGER_QUERY_URL = os.environ.get("JAEGER_QUERY_URL", "http://127.0.0.1:16686").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
MODEL_NAME = os.environ.get("MODEL_NAME", "feature-model")
DECOY_MODEL_NAME = "other-team-model"

# How long the fault proxy hangs in `slow` mode (manifest.yaml). The bound
# below is well under this, so a pass can only happen because the template
# gave up on its own -- not because the hang itself was short.
FAULT_SLOW_SECONDS = float(os.environ.get("FAULT_SLOW_SECONDS", "30"))
MAX_HUNG_CALL_LATENCY_S = 15.0

NORMAL_CALL_TIMEOUT_S = 15
HUNG_CALL_TIMEOUT_S = FAULT_SLOW_SECONDS + 20
TRACE_POLL_TIMEOUT_S = 30
TRACE_POLL_INTERVAL_S = 1


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _get_json(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)


def _post_json(url, body, headers=None, timeout=10):
    data = json.dumps(body).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method="POST", headers=hdrs)
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


def _fault_proxy_mode(mode):
    return _post_json(FAULT_PROXY_URL + "/admin/mode", {"mode": mode})


def _call_template(question, timeout):
    started = time.time()
    status, body = _post_json(TEMPLATE_URL + "/answer", {"question": question}, timeout=timeout)
    ms = int((time.time() - started) * 1000)
    trace_id = body.get("trace_id") if isinstance(body, dict) else None
    return {"status": status, "body": body, "ms": ms, "trace_id": trace_id}


def _flatten_v3(v3_json):
    rows = []
    if not v3_json:
        return rows
    for rs in (v3_json.get("result") or {}).get("resourceSpans", []) or []:
        svc = None
        for a in (rs.get("resource") or {}).get("attributes", []) or []:
            if a.get("key") == "service.name":
                svc = (a.get("value") or {}).get("stringValue")
        for ss in rs.get("scopeSpans", []) or []:
            for sp in ss.get("spans", []) or []:
                rows.append({"service": svc, "name": sp.get("name"), "span_id": sp.get("spanId")})
    return rows


def _poll_trace_for_template_span(trace_id, timeout_s=TRACE_POLL_TIMEOUT_S):
    if not trace_id or trace_id == "0" * 32:
        # Not even a real-looking trace id -- no point polling Jaeger for it.
        return []
    deadline = time.time() + timeout_s
    last_rows = []
    url = JAEGER_QUERY_URL + "/api/v3/traces/" + trace_id
    while time.time() < deadline:
        status, data = _get_json(url, timeout=5)
        rows = _flatten_v3(data if isinstance(data, dict) else None)
        if rows:
            last_rows = rows
        if any(r.get("service") == "opalix-template" for r in rows):
            return rows
        time.sleep(TRACE_POLL_INTERVAL_S)
    return last_rows


def _read_credentials():
    try:
        with open(CREDENTIALS_FILE) as f:
            return json.load(f), None
    except (OSError, ValueError) as e:
        return None, str(e)


def _chat(key, model, timeout=10):
    status, _ = _post_json(
        LITELLM_URL + "/chat/completions",
        {"model": model, "messages": [{"role": "user", "content": "grader probe"}]},
        headers={"Authorization": "Bearer %s" % key},
        timeout=timeout,
    )
    return status


def _build_results():
    results = {"setup_error": None}
    try:
        # Clean slate.
        _fault_proxy_mode("healthy")

        # --- 1. a normal call, for the tracing check -------------------
        normal = _call_template("what paved road am I standing on?", NORMAL_CALL_TIMEOUT_S)
        results["normal_call"] = normal
        if normal.get("status") == 200 and normal.get("trace_id"):
            results["normal_call_spans"] = _poll_trace_for_template_span(normal["trace_id"])
        else:
            results["normal_call_spans"] = []

        # --- 2. a hung provider, for the timeout+retry check ------------
        _fault_proxy_mode("slow")
        try:
            hung = _call_template("does this hang forever?", HUNG_CALL_TIMEOUT_S)
        finally:
            # Always leave the provider healthy again, even if the call
            # above raised -- a crashed grading run must never leave the
            # provider stuck hanging for the learner.
            _fault_proxy_mode("healthy")
        results["hung_call"] = hung

        # --- 3. the template's own credential, for the scoping check ----
        creds, creds_err = _read_credentials()
        results["credentials_error"] = creds_err
        if creds is not None:
            key = creds.get("api_key", "")
            results["credential"] = {
                "present": bool(key),
                "equals_master_key": bool(key) and key == LITELLM_MASTER_KEY,
            }
            if key:
                status, body = _get_json(
                    LITELLM_URL + "/key/info?key=%s" % key,
                    headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
                )
                info = (body or {}).get("info", {}) if isinstance(body, dict) else {}
                results["credential"]["key_info_status"] = status
                results["credential"]["models"] = info.get("models")
                results["credential"]["reaches_feature_model"] = _chat(key, MODEL_NAME)
                results["credential"]["reaches_decoy_model"] = _chat(key, DECOY_MODEL_NAME)
                admin_status, _ = _get_json(
                    LITELLM_URL + "/user/list", headers={"Authorization": "Bearer %s" % key}
                )
                results["credential"]["can_list_users"] = admin_status == 200

                # The direct proof that the TEMPLATE SERVICE ITSELF actually
                # uses this exact credential live, not just that a scoped
                # credential happens to sit on disk next to a service that
                # might really be using something else (the master key,
                # say): block this specific key at the gateway, then fire a
                # real call straight through the template's own /answer. If
                # the template is really authenticating with this key, that
                # call must now fail -- if it still succeeds, the template
                # is reaching the gateway with some other, unaccounted-for
                # credential. Always unblocked again in a finally, even if
                # the probe call itself raises.
                _post_json(
                    LITELLM_URL + "/key/block", {"key": key},
                    headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
                )
                try:
                    blocked_call = _call_template("does this still work with a blocked credential?", NORMAL_CALL_TIMEOUT_S)
                finally:
                    _post_json(
                        LITELLM_URL + "/key/unblock", {"key": key},
                        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
                    )
                results["credential"]["still_works_while_blocked"] = blocked_call.get("status") == 200

        return results
    except Exception as e:  # noqa: BLE001 -- a grading-infra failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        try:
            _fault_proxy_mode("healthy")
        except Exception:
            pass
        return results


def get_results():
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

    deadline = time.time() + HUNG_CALL_TIMEOUT_S + TRACE_POLL_TIMEOUT_S + 60
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_a_hung_provider_does_not_block_the_feature():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    hung = r.get("hung_call") or {}
    if hung.get("status") is None:
        _finish(False, "the template never answered at all while the provider was hung: %r" % hung.get("body"))

    ms = hung.get("ms") or 0
    if ms > MAX_HUNG_CALL_LATENCY_S * 1000:
        _finish(
            False,
            "the template took %.1fs to answer while the provider was hung (allowed: %.1fs, and the "
            "provider itself was going to stay hung for %.0fs) -- its outbound call has no real bound"
            % (ms / 1000.0, MAX_HUNG_CALL_LATENCY_S, FAULT_SLOW_SECONDS),
        )
    if hung.get("status") == 200:
        _finish(
            False,
            "the template returned 200 in %.1fs while the provider was hung for %.0fs -- that isn't "
            "possible unless it answered without ever actually waiting on the gateway" % (ms / 1000.0, FAULT_SLOW_SECONDS),
        )
    _finish(
        True,
        "the template gave up on the hung provider and answered in %.1fs, well under the %.0fs it was "
        "hung for" % (ms / 1000.0, FAULT_SLOW_SECONDS),
    )


def check_normal_calls_show_up_in_jaeger():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    normal = r.get("normal_call") or {}
    if normal.get("status") != 200:
        _finish(False, "a plain call to POST /answer did not even succeed: status=%r body=%r" % (normal.get("status"), normal.get("body")))

    trace_id = normal.get("trace_id")
    if not trace_id or trace_id == "0" * 32:
        _finish(
            False,
            "the template's own response carried trace_id=%r -- that is not a real, exported span's "
            "trace id, it's what you get from a no-op tracer" % trace_id,
        )

    spans = r.get("normal_call_spans") or []
    template_spans = [s for s in spans if s.get("service") == "opalix-template"]
    if not template_spans:
        _finish(
            False,
            "Jaeger never received any opalix-template span for trace %s, even after polling for %ss -- "
            "the call succeeded, so this is the tracer, not the network" % (trace_id, TRACE_POLL_TIMEOUT_S),
        )
    _finish(
        True,
        "trace %s carries %d real opalix-template span(s) in Jaeger" % (trace_id, len(template_spans)),
    )


def check_the_templates_credential_is_scoped():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("credentials_error"):
        _finish(False, "could not read the template's credentials.json: %s" % r["credentials_error"])

    c = r.get("credential") or {}
    if not c.get("present"):
        _finish(False, "credentials.json has no api_key for the template service")
    if c.get("equals_master_key"):
        _finish(False, "the template's credential is literally the gateway's master key")
    if c.get("key_info_status") != 200:
        _finish(False, "litellm's own GET /key/info does not recognize the template's credential at all (status=%r)" % c.get("key_info_status"))
    if c.get("reaches_feature_model") != 200:
        _finish(False, "the template's own credential cannot call %s, which it should be allowed to (status=%r)" % (MODEL_NAME, c.get("reaches_feature_model")))
    if c.get("reaches_decoy_model") == 200:
        _finish(False, "the template's credential can call %s, another team's alias it was never granted" % DECOY_MODEL_NAME)
    if c.get("can_list_users"):
        _finish(False, "the template's credential can call GET /user/list, a proxy-admin-only endpoint -- that is effectively a master key")
    if c.get("still_works_while_blocked"):
        _finish(
            False,
            "blocking credentials.json's own key at the gateway did not stop the template from answering -- "
            "the running service is not actually authenticating with this credential at all",
        )
    _finish(
        True,
        "the template's credential is not the master key, reaches only %s, is refused for %s and for "
        "admin-only endpoints, and blocking it at the gateway actually breaks the running service"
        % (MODEL_NAME, DECOY_MODEL_NAME),
    )


COMMANDS = {
    "a-hung-provider-does-not-block-the-feature": check_a_hung_provider_does_not_block_the_feature,
    "normal-calls-show-up-in-jaeger": check_normal_calls_show_up_in_jaeger,
    "the-templates-credential-is-scoped": check_the_templates_credential_is_scoped,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
