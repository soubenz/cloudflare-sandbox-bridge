# The provider is down, and so are we

The front desk is an agent. Requests from customers land in a queue; for each
one it asks the model where the request belongs and what the customer should be
told first, and it files the answer in the case log. Queue owners work from
that log. It is the only thing that says a request arrived.

The model provider had an outage this morning, from about nine. It is partly
back now. The desk did not get slower during it and it did not answer worse —
it stopped. Requests came in and nothing came out the other end, and the first
anybody knew about it was a customer asking why the status page says everything
is fine.

One of the requests is Grace Achebe's, at Halyard Freight: locked out since
nine, three of her team with her, a customer call at two. There is no row for
her in the case log. Not a failed one — none. And since the provider came back
it has been answering some calls with a body that is not quite the body it used
to send: those requests have rows, and one of them is blank.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the desk over the queue. The graders run this exact command. |
| `agent/` | The agent: the queue, the provider call, the retry policy, the standing rules, the case log, the run loop. |
| `intake.json` | This morning's queue, seven requests. |
| **provider** tab | Every model call the desk made: what was asked, what the provider actually said, what came back, and what was done to the reply before the desk saw it. |

Two services are running: the provider proxy on port 8861 and the desk — the
case log and the standing rules — on 8862.

The proxy is worth understanding, because it is not a stub. The model calls in
this lab are real: they leave the container, reach a real provider, and come
back with whatever a real model says. Nothing in here holds a credential for
it — one is added on the way out, outside the container. What the proxy does is
sit in front of that provider and reproduce, on a fixed schedule, what it was
doing this morning: some requests it will not ask about at all, one it leaves
hanging, and two whose answers it changes the shape of on the way back. Which
requests those are is the same on every run. **What the provider says is not** —
it is a real model, its wording varies between two identical calls, and nothing
in this lab is graded on it.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **provider** tab, and compare its rows with what the agent
printed.

## Your task

Make the desk survive the provider instead of stopping with it.

Concretely: every request in the queue ends up in the case log with something
a queue owner can act on, and a reply that is not usable is reported as one,
saying what was wrong with it.

That is the whole of it. But note what the desk has to keep doing while you fix
it. The requests the provider answers normally still have to be answered from
its answers — a desk that meets every request with the same safe sentence has
not survived the outage, it has switched the model off, and it looks exactly
like a working desk from the outside. That is the same bug wearing a better
disguise, and it is graded.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over the queue,
and grades what the services recorded. Nothing reads your source, so any
correct fix passes and no cosmetic one does. Nothing is graded on the model's
wording either: where a check has to know what the provider answered, it reads
what the proxy recorded serving, and asks whether the case log agrees with it.

| Check | Passes when |
|---|---|
| `degrades-instead-of-stopping` | Every request the provider would not answer is still in the case log, with a disposition or a reason. |
| `wrong-shape-replies-are-rejected` | A 200 whose body is the wrong shape is refused rather than half-read or swallowed, and the filing names what was wrong with it. |
| `good-answers-still-get-through` | The requests the provider answered normally are filed with the provider's own answer. |

The second and third exist to stop the first being satisfied the easy way. You
need all three.

## Worth knowing

HTTP 200 means something answered. It does not mean the thing that answered is
the thing you were talking to yesterday. Providers fail over to other pools,
roll deploys forward and back, and put new gateways in front of old models, and
the body that comes out of the far end after an incident is not always the body
that went in before it — a `content` that used to be a string arriving as a list
of parts is not a hypothetical, it is what two of the large providers return
today.

Which is why the place where an outside response becomes an inside value is the
one place worth being rude at. Code written to be forgiving there — a default
instead of a check, an `or ""` instead of a refusal — does not make the system
tolerant. It converts "this is not what I expected" into "what I expected,
empty", which is the one answer that nothing further down the line can tell
apart from a real one. The forgiving version of that code is how a customer ends
up with a case marked answered and nobody looking at it.
