# It answers, but it is wrong

The policy desk is an agent. Questions from Support, Returns and Partners
land in a queue; for each one it looks up the warranty and returns clauses
that bear on the question, asks a model for the answer, and files the answer
that goes back to the customer.

It is good. It is also, sometimes, wrong. Last month three customers came
back holding answers from the desk that we cannot honour. One of them is a
customer of Priya Raghunathan's who was told the battery in a K2 is covered
for the full 24 months. It is a wear part. It is covered for 12. Priya sent
that answer on because the desk gave it to her, and the customer has the
email.

The desk answered 214 questions last month. Three of them we know about
because somebody complained. Nobody can tell us anything about the other
211, and that is the actual problem: there were no errors, nothing timed
out, no alert fired, and every one of those answers reads exactly as well as
the ones that were right. Priya's question is in this morning's queue, by the
way. The desk answered it too.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the desk over the queue. The graders run this exact command. |
| `agent/` | The desk: the queue, the clause lookup, the model call, the retry policy, what it does when a call is refused, a tracer. |
| `questions.json` | This morning's queue, seven questions. |
| **desk** tab | The proxy: the calls it served, and the trace the desk wrote for them, side by side. It marks every call that no span names. |

Two services are running. The **desk proxy** on port 8871 is the only route
to a model: it holds the credential this container does not have, it pins the
route's model, and it keeps a row for every call it handled — status, model,
the reason the model stopped, cache, duration. It does **not** keep the
prompts or the replies, on purpose: customer questions are pasted into them
in full and the proxy was not going to become the place they are retained.
That decision stands.

The same service holds the **trace store**, which is where the desk records
what a turn did. `agent/trace.py` documents it and uses it; the essentials
are that a span carries `turn_id`, `question_id` and `kind` (`turn`,
`model_call`, `tool_call`, `decision`, `note`), optionally a `request_id` —
the proxy's exchange id, which is the one thing that ties a span to a call
the gateway really served — and a small flat `attrs`. The store keeps
**24 spans and 4096 bytes per turn**; past that it says the turn is over
budget, and it means it. One span over 4096 bytes is refused outright, so a
span is not somewhere a whole prompt fits.

The **policy service** on port 8872 is the clause store and the reply log.
Both services are deliberately unreliable, in fixed ways, so that every run
sees the same refusals and the same stale read. Nothing in this queue is
unanswerable.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **desk** tab, and read what the trace says about the run you
just did.

## Your task

Make the desk explicable, and then use that to make it right.

Both halves are graded, and each one without the other is worse than it
looks. A trace that records every turn and no answer that changed is a
system you can now watch being wrong. A fixed answer with nothing recorded is
this same morning three weeks from now, with a different cause and the same
211 questions nobody can check. And recording *everything* — the prompt, the
reply, a line per branch taken — is the third way to end up here: nobody
reads it, finance asks about it, and it gets turned off. There is a budget
per turn and it is graded too.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over the
queue, and grades what the services recorded. Nothing reads your source, and
nothing reads the text of an answer — whether a sentence sounds right is the
judgement this lab exists to replace.

| Check | Passes when |
|---|---|
| `every-turn-is-attributable` | Every model call and every clause lookup the run made is in the trace, against the turn it belongs to, and the calls that produced answers are named by the exchange id the proxy recorded them under. |
| `answers-came-from-the-evidence` | Every question is answered, and the call the answer came out of carried the clauses the handbook served for that question. |
| `the-trace-is-proportionate` | No turn is over the trace store's span or byte budget. |

The first two are the two halves of the task and neither one satisfies the
other. The third is what stops the first being satisfied by writing down
everything. You need all three.

## Worth knowing

A 5xx is a sentence somebody wrote about a class of failure, not a
specification of your request. Read too literally, it invites a fix that
makes the error go away by asking a question you were not asked — and a
model given less to go on does not fail, it answers anyway, fluently, in the
customer's own thread, with nothing in the reply to say what was missing.
That is why this is a recording problem before it is a bug: the difference
between a retry and a quiet substitution is invisible in the result, visible
in the request, and the request is the thing nobody kept.
