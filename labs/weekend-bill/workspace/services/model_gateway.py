#!/usr/bin/env python3
"""Stand-in for the model gateway -- and for the invoice it sends you.

There is no real model in this lab and no route out of the container to
one. This service speaks the chat-completions shape, decides on each call
whether the agent should search again or has enough to answer, and -- the
part that matters here -- *prices every call it handles* and keeps the
running total for the month. What you see on ``/api/log`` and in the
**ledger** tab is the bill, not an estimate of it.

Three things about it are worth reading before you debug the agent:

1. It bills in the usual way: a price per thousand prompt tokens and a
   higher price per thousand completion tokens, both read from its
   environment. Every reply carries its own ``usage`` block, including
   ``cost_usd`` for that one call.

2. A call it refuses is still a call it read. When it returns 503 the
   prompt has already been tokenised and charged; there is no completion,
   so there is no completion charge and no ``usage`` block in the error
   body. A caller that adds up the ``usage`` it was handed will therefore
   total less than the ledger does.

3. It fails, and it converges, on purpose and deterministically, for fixed
   lists of question ids read from its environment at start-up. Nothing
   here is random and nothing here looks at the clock.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("MODEL_PORT", "8791"))

PRICE_IN = float(os.environ.get("PRICE_PER_1K_INPUT", "0.003"))
PRICE_OUT = float(os.environ.get("PRICE_PER_1K_OUTPUT", "0.015"))
BUDGET_USD = float(os.environ.get("BUDGET_USD", "0.75"))

# How many *completed* calls a question takes before the model has enough to
# answer. Deterministic fault injection, all of it keyed to the question id:
#
#   CONVERGE_STEP      the normal case -- two searches, then an answer.
#   RUNAWAY_*          questions the model never resolves quickly. It does
#                      converge in the end, so an unbounded loop terminates
#                      rather than hanging, but it converges a very long way
#                      past the point where the spend stopped being sane.
#   FAULT_503_*        a transient overload: the first N calls for the
#                      question are charged and refused, everything after
#                      them succeeds. This is the call that has to survive.
#   HARD_503_*         a question the provider refuses every single time.
#                      There is no number of retries that gets an answer; a
#                      retry policy exists to bound what it costs to find
#                      that out.
CONVERGE_STEP = int(os.environ.get("MODEL_CONVERGE_STEP", "3"))
RUNAWAY = [q for q in os.environ.get("MODEL_RUNAWAY_QUESTIONS", "").split(",") if q]
RUNAWAY_STEP = int(os.environ.get("MODEL_RUNAWAY_STEP", "150"))
FAULT_503 = [q for q in os.environ.get("MODEL_FAULT_503_QUESTIONS", "").split(",") if q]
FAULT_503_CALLS = int(os.environ.get("MODEL_FAULT_503_CALLS", "2"))
HARD_503 = [q for q in os.environ.get("MODEL_HARD_503_QUESTIONS", "").split(",") if q]

ROUTES = ("/v1/chat/completions", "/api/spend", "/api/log", "/api/reset", "/healthz")

_lock = threading.Lock()
_state = {
    "calls": [],          # every call, charged, in order
    "attempts": {},       # question_id -> calls handled so far
    "completions": {},    # question_id -> calls that produced a completion
    "cost_usd": 0.0,      # the running total, which is the bill
    "prompt_tokens": 0,
    "completion_tokens": 0,
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8791/api/log and behind the session proxy at
    /sessions/<id>/services/ledger/api/log."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _tokens(text):
    """Words to tokens, near enough for an invoice in a lab."""
    return max(1, int(len(text.split()) * 1.3))


def _question_id(raw_body, prompt):
    """Finds which question this call is about.

    Deliberately not tied to the request's layout. Which questions are
    expensive and which fail is keyed to the question id, and the
    ``metadata.question_id`` field and the labelled ``Question`` line only
    exist because agent/model.py happens to write them today. A learner who
    rewrites the prompt builder, or drops the metadata, is not making the
    bug worse and should not silently turn the faults off and then be told
    their retries are missing. So: match the id anywhere in the whole
    request body first, and fall back to a labelled line.
    """
    match = re.search(r"\bQ-\d{4}\b", raw_body)
    if match:
        return match.group(0)
    match = re.search(r"^Question(?: ID)?:[ \t]*(\S+)", prompt, re.MULTILINE)
    return match.group(1).strip() if match else "unknown"


# A real model does not return the same bytes twice for the same prompt, and
# this stub does not pretend otherwise: it rotates what it says per call, and
# the rotation entries are deliberately different lengths. What is
# deterministic is *which* question a call is about and *whether* it
# converges -- not how many tokens it takes to say so. Anything that assumes
# a fixed price per call, or a fixed number of tokens per question, is
# assuming something no provider gives you.
THOUGHTS = [
    (
        "I do not have enough to answer this yet. The question turns on which accounts are "
        "actually in scope, and the only way to know that is to look at what the internal "
        "notes say rather than to guess from the phrasing. I will search for the closest "
        "match and see whether it names the accounts directly or only the policy."
    ),
    (
        "That helped a little but it is not conclusive. The note I just read describes the "
        "general rule and mentions two exceptions without listing them, so I still cannot "
        "name the accounts affected. Searching again with the exception wording should turn "
        "up the page that enumerates them, if such a page exists at all."
    ),
    (
        "Still partial. I can see the shape of the answer now: there is a policy, a list of "
        "exceptions somewhere, and at least one thread where someone asked this before and "
        "got a partial reply. Pulling that thread up next seems more promising than another "
        "pass at the policy page, which I have now read twice."
    ),
    (
        "I am going in circles on the phrasing, so let me widen it. If the internal notes do "
        "not answer this directly then the next best evidence is whatever the support "
        "threads say, because someone has almost certainly been asked this by a customer and "
        "written down what they told them."
    ),
    (
        "Close, but I want one more source before I commit to an answer, because the last two "
        "results disagree about the date the rule took effect and the answer changes "
        "depending on which one is right."
    ),
]

ANSWER = (
    "Short answer: {summary}\n\n"
    "The internal notes cover this in two places and they agree. The policy page states the "
    "rule, and the support thread from last quarter shows how it was explained to a customer, "
    "which is the wording I would reuse here. There is one exception worth flagging to whoever "
    "acts on this, noted below.\n\n"
    "Exception: accounts that were migrated before the cutover are handled by the older "
    "process, so anything said here does not apply to them without checking first.\n\n"
    "Sources: the policy page, and the support thread of the same title."
)

SUMMARIES = [
    "yes, with one exception, and the exception is the part worth reading twice.",
    "no -- the rule people remember was replaced, and the replacement says the opposite.",
    "it depends on the account's migration date, and there are three of those to check.",
    "yes, and it has been true since the cutover, which is why the older note disagrees.",
]


def _charge(question_id, attempt, step, prompt_tokens, completion_tokens, outcome):
    """Records and bills one call. Called with the lock held."""
    cost = (prompt_tokens / 1000.0) * PRICE_IN + (completion_tokens / 1000.0) * PRICE_OUT
    _state["cost_usd"] += cost
    _state["prompt_tokens"] += prompt_tokens
    _state["completion_tokens"] += completion_tokens
    _state["calls"].append(
        {
            "seq": len(_state["calls"]) + 1,
            "question_id": question_id,
            "attempt": attempt,
            "step": step,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "cost_usd": round(cost, 6),
            "cumulative_usd": round(_state["cost_usd"], 6),
            "outcome": outcome,
            "at": _now(),
        }
    )
    return cost


def complete(raw_body, payload):
    """Handles one chat completion. Returns (status, body).

    Which question a call is about, whether it fails, and whether it
    converges are all fixed functions of (question id, calls seen since the
    last reset). What the model *says*, and therefore what the call costs,
    varies per call the way a real one does.
    """
    messages = payload.get("messages") or []
    prompt = "\n".join(str(m.get("content", "")) for m in messages)
    question_id = _question_id(raw_body, prompt)
    prompt_tokens = _tokens(prompt) if prompt.strip() else _tokens(raw_body)

    with _lock:
        attempt = _state["attempts"].get(question_id, 0) + 1
        _state["attempts"][question_id] = attempt

        refuse = question_id in HARD_503 or (
            question_id in FAULT_503 and attempt <= FAULT_503_CALLS
        )
        if refuse:
            # The prompt has now been read, tokenised and charged. Everything
            # below decides only what the caller gets to hear about it -- and
            # an error body carries no usage block, so a caller that totals
            # up its own usage will never see this line.
            _charge(question_id, attempt, None, prompt_tokens, 0, "charged_then_overloaded")
            return 503, {
                "error": {
                    "message": "the model is overloaded for this request, retry shortly",
                    "type": "server_error",
                }
            }

        step = _state["completions"].get(question_id, 0) + 1
        _state["completions"][question_id] = step

        enough = RUNAWAY_STEP if question_id in RUNAWAY else CONVERGE_STEP
        if step >= enough:
            text = ANSWER.format(summary=SUMMARIES[(step - 1) % len(SUMMARIES)])
            outcome, finish = "answered", "stop"
            tool_calls = None
        else:
            text = THOUGHTS[(step - 1) % len(THOUGHTS)]
            outcome, finish = "searched", "tool_calls"
            tool_calls = [
                {
                    "id": "call_%s_%d" % (question_id, step),
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": json.dumps(
                            {"query": "%s -- angle %d" % (question_id, step)}
                        ),
                    },
                }
            ]

        completion_tokens = _tokens(text) + (12 if tool_calls else 0)
        cost = _charge(
            question_id, attempt, step, prompt_tokens, completion_tokens, outcome
        )

    message = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return 200, {
        "id": "chatcmpl-%s-%d" % (question_id, step),
        "object": "chat.completion",
        "model": payload.get("model", "opalix-research-stub"),
        "choices": [{"index": 0, "finish_reason": finish, "message": message}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "cost_usd": round(cost, 6),
        },
    }


def by_question():
    """One row per question: calls, steps, tokens, what it cost. Lock held."""
    rows = {}
    for call in _state["calls"]:
        row = rows.setdefault(
            call["question_id"],
            {
                "question_id": call["question_id"],
                "calls": 0,
                "steps": 0,
                "refused": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cost_usd": 0.0,
            },
        )
        row["calls"] += 1
        if call["outcome"] == "charged_then_overloaded":
            row["refused"] += 1
        else:
            row["steps"] += 1
        row["prompt_tokens"] += call["prompt_tokens"]
        row["completion_tokens"] += call["completion_tokens"]
        row["cost_usd"] = round(row["cost_usd"] + call["cost_usd"], 6)
    return rows


def snapshot(include_calls=True):
    with _lock:
        out = {
            "totals": {
                "calls": len(_state["calls"]),
                "prompt_tokens": _state["prompt_tokens"],
                "completion_tokens": _state["completion_tokens"],
                "cost_usd": round(_state["cost_usd"], 6),
                "budget_usd": BUDGET_USD,
                "price_per_1k_input": PRICE_IN,
                "price_per_1k_output": PRICE_OUT,
            },
            "by_question": sorted(
                by_question().values(), key=lambda r: -r["cost_usd"]
            ),
        }
        if include_calls:
            out["calls"] = list(_state["calls"])
        return out


def reset():
    with _lock:
        _state["calls"] = []
        _state["attempts"] = {}
        _state["completions"] = {}
        _state["cost_usd"] = 0.0
        _state["prompt_tokens"] = 0
        _state["completion_tokens"] = 0


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Ledger</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:.95rem;margin:2rem 0 .5rem;color:#444}
 p.sub{color:#666;margin:0 0 1.5rem}
 #summary{font-size:1rem;margin:0 0 1.5rem;padding:.6rem .8rem;border-left:3px solid #999;background:#fafafa}
 #summary.over{border-left-color:#c00;background:#fff4f4}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 th.n{text-align:right}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 tr.hot td{background:#fff4f4}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.warn{background:#a60}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.over{background:#3a1c1c;border-left-color:#c00}
  tr.hot td{background:#3a1c1c} th{color:#999}
 }
</style></head><body>
<h1>Ledger</h1>
<p class="sub">What the model gateway charged this run, per question. Refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>By question</h2>
<table><thead><tr><th>Question</th><th class="n">Model calls</th><th class="n">Refused</th>
<th class="n">Prompt tokens</th><th class="n">Completion tokens</th><th class="n">Cost</th><th class="n">Share</th></tr></thead>
<tbody id="rows"></tbody></table>
<h2>Last 20 calls</h2>
<table><thead><tr><th>#</th><th>Question</th><th class="n">Attempt</th><th class="n">Step</th>
<th class="n">In</th><th class="n">Out</th><th class="n">Cost</th><th>Outcome</th><th>At</th></tr></thead>
<tbody id="calls"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
const usd = n => {
  if (n >= 1) return "$" + n.toFixed(2);
  let s = n.toFixed(4).replace(/0+$/, "");
  while (s.split(".")[1].length < 2) s += "0";
  return "$" + s;
};
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/spend")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the gateway"; return; }
  const t = data.totals || {}, rows = data.by_question || [], calls = data.calls || [];
  const total = t.cost_usd || 0, budget = t.budget_usd || 0;
  const over = budget > 0 && total > budget;
  // Flagged against the budget, not against the run's own total: in a run
  // that is inside the budget, no single question is a problem.
  const hot = r => budget > 0 && r.cost_usd >= budget * 0.25;
  const worst = rows.filter(hot);
  const s = document.getElementById("summary");
  s.className = over ? "over" : "";
  s.textContent = usd(total) + " charged for " + rows.length + " question(s) over " +
    (t.calls || 0) + " model call(s). The budget for one run of the queue is " + usd(budget) + " — " +
    (over ? "this run is " + (budget ? (total / budget).toFixed(1) : "?") + "x over it" : "this run is inside it") +
    (worst.length ? ". " + worst.map(r => r.question_id + " alone cost " + usd(r.cost_usd) +
      " over " + r.calls + " call(s)").join("; ") + "." : ".");
  document.getElementById("rows").innerHTML = rows.map(r => {
    const share = total > 0 ? r.cost_usd / total : 0;
    return `<tr class="${hot(r) ? "hot" : ""}"><td>${r.question_id}` +
      (hot(r) ? ' <span class="tag">runaway</span>' : "") +
      (r.steps === 0 && r.refused > 0 ? ' <span class="tag warn">never answered</span>' : "") +
      `</td><td class="n">${r.calls}</td><td class="n">${r.refused || ""}</td>` +
      `<td class="n">${r.prompt_tokens.toLocaleString()}</td><td class="n">${r.completion_tokens.toLocaleString()}</td>` +
      `<td class="n">${usd(r.cost_usd)}</td><td class="n">${(share * 100).toFixed(0)}%</td></tr>`;
  }).join("") || '<tr><td colspan="7" class="empty">no calls yet</td></tr>';
  document.getElementById("calls").innerHTML = calls.slice(-20).reverse().map(c =>
    `<tr><td>${c.seq}</td><td>${c.question_id}</td><td class="n">${c.attempt}</td>` +
    `<td class="n">${c.step === null ? "—" : c.step}</td><td class="n">${c.prompt_tokens}</td>` +
    `<td class="n">${c.completion_tokens}</td><td class="n">${usd(c.cost_usd)}</td>` +
    `<td><code>${c.outcome}</code></td><td>${c.at}</td></tr>`).join("");
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-gateway/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("gateway %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "ledger"})
        if route == "/api/log":
            return self._send(200, snapshot())
        if route == "/api/spend":
            # Same numbers, last 20 calls only, for the page that polls it.
            data = snapshot()
            data["calls"] = data["calls"][-20:]
            return self._send(200, data)
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route != "/v1/chat/completions":
            return self._send(404, {"error": {"message": "no such endpoint: %s" % self.path}})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        text = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            return self._send(400, {"error": {"message": "body must be JSON"}})

        status, body = complete(text, payload)
        try:
            self._send(status, body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up waiting and closed the socket. The call is
            # charged either way -- that is the point -- and letting the
            # traceback print would put a red herring in the log of a lab
            # about not trusting the caller's own accounting.
            pass


def main():
    print(
        "gateway listening on :%d (converge at %d, runaway %s at %d, 503 for %s x%d, hard 503 for %s; "
        "$%.4f/1k in, $%.4f/1k out, budget $%.2f)"
        % (
            PORT, CONVERGE_STEP, ",".join(RUNAWAY) or "-", RUNAWAY_STEP,
            ",".join(FAULT_503) or "-", FAULT_503_CALLS, ",".join(HARD_503) or "-",
            PRICE_IN, PRICE_OUT, BUDGET_USD,
        ),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
