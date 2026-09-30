# The provider is down, and so are we

The front desk is an agent. Customer requests land in a queue; for each one it
asks the model where the request belongs and what the customer should be told
first, and files the answer in the case log, the only record that a request
arrived.

The model provider had an outage this morning from about nine, and is partly
back. The desk did not slow down or answer worse: it stopped, and the first
anybody knew was a customer asking why the status page says all is well.

Grace Achebe, at Halyard Freight, has been locked out since nine. There is no
row for her in the case log, not even a failed one. And since the provider came back it has answered some calls with a body
that is not quite the old one: those requests have rows, and one is blank.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the desk over the queue. The graders run this command. |
| `agent/` | The agent: queue, provider call, retry policy, rules, case log, run loop. |
| `intake.json` | This morning's queue, seven requests. |
| **provider** tab | Every model call: what was asked, what the provider said, what came back. |

Two services are running: the provider proxy on port 8861 and the desk (case
log and standing rules) on 8862. The model is real; the proxy in front of it
refuses to ask about some requests, leaves one hanging, and reshapes two
answers, the same ones every run. **What the provider says is not**, and
nothing is graded on its wording.

Start in the **Terminal**, then compare the **provider** tab:

```bash
python3 run_agent.py
```

## Your task

Make the desk survive the provider: every request ends up in the case log with
something a queue owner can act on, and an unusable reply is reported as one,
saying what was wrong.

Requests the provider answers normally must still be answered from its answers.
A desk that meets everything with the same safe sentence has switched the model
off. That is the same bug in disguise, and it is graded.

At minute 8 three more requests land, one on Grace's account; checks run against
what is true at the end.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py`, and grades what
the services recorded, not your source.

| Check | Passes when |
|---|---|
| `degrades-instead-of-stopping` | Every request the provider would not answer is in the case log with a disposition or reason. |
| `wrong-shape-replies-are-rejected` | A 200 with a wrong-shaped body is refused, not swallowed, and the filing says why. |
| `good-answers-still-get-through` | Normal answers are filed with the provider's own answer. |

You need all three.

## Worth knowing

HTTP 200 means something answered, not that it is what you talked to
yesterday: a `content` that was a string can arrive as a list of parts. A
default instead of a check, an `or ""` instead of a refusal, turns "not what I
expected" into "empty", which nothing downstream can tell from a real answer.
