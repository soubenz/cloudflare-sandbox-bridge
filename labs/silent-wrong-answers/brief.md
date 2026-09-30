# It answers, but it is wrong

The policy desk is an agent. Questions from Support, Returns and Partners land
in a queue; for each one it looks up the warranty and returns clauses that bear
on the question, asks a model for the answer, and files the answer that goes
back to the customer.

It is good. It is also, sometimes, wrong. Last month three customers came back
holding answers we cannot honour. One of them was told the battery in a K2 is
covered for 24 months. It is a wear part, covered for 12, and the customer has
the email. The desk answered 214 questions last month. We know about three
because somebody complained. Nobody can tell us anything about the other 211:
no errors, no timeouts, no alerts, and every answer reads as well as the right
ones. Priya's question is in this morning's queue. The desk answered it too.

## What is running

| Where | What |
|---|---|
| `run_agent.py` | Runs the desk over the queue. The graders run this exact command. |
| `agent/` | The desk: queue, clause lookup, model call, retry policy, what it does when a call is refused, a tracer. |
| `questions.json` | This morning's queue, seven questions. |
| **desk** tab | The proxy's record of the calls it served and the trace the desk wrote for them, side by side. It marks every call no span names. |

The **desk proxy** (port 8871) is the only route to a model. It keeps a row for
every call it handled, but deliberately not the prompts or replies, because
customer questions are pasted into them; that decision stands. The same service
holds the **trace store**: a span carries `turn_id`, `question_id` and `kind`
(`turn`, `model_call`, `tool_call`, `decision`, `note`), optionally the proxy's
exchange id as `request_id`, and a small flat `attrs`. `agent/trace.py`
documents it. The **policy service** (port 8872) is the clause store and reply
log. Both are unreliable in fixed ways, so every run sees the same refusals and
the same stale read. Nothing in this queue is unanswerable.

Start in the **Terminal** with `python3 run_agent.py`, then read what the desk
tab says about that run.

## What done looks like

The desk is explicable, and then right. A trace of every turn with no answer
changed is a system you can watch being wrong; a fixed answer with nothing
recorded is this same morning three weeks from now. Recording everything (the
prompt, the reply, a line per branch) is the third way to end up here: nobody
reads it and it gets turned off. The store keeps **24 spans and 4096 bytes per
turn**, and an empty trace is not a small one.

## Checks

**Run checks** resets both services, runs *your* `run_agent.py` over the queue
and grades what the services recorded. Nothing reads your source or the text of
an answer.

| Check | Passes when |
|---|---|
| `every-turn-is-attributable` | Every model call and clause lookup is in the trace against its turn, and the calls that produced answers are named by the exchange id the proxy recorded. |
| `answers-came-from-the-evidence` | Every question is answered, from a call that carried the clauses the handbook served for it. |
| `the-trace-is-proportionate` | The run recorded spans, and no turn is over the span or byte budget. |

You need all three. At minute 12, four more questions land, one from the Head
of Support asking which of last month's answers were wrong.
