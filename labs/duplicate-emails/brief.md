# Customers are getting the same reply twice

Support runs an agent over the overnight ticket queue. It reads each
ticket, drafts a reply, and emails it.

Since Tuesday, customers have been complaining that they get the same reply
two or three times. One of them is Ada Okonkwo, who wrote in because she was
*charged twice*. She has now been told twice that we are looking into it.

The agent's own log says it sent one message per ticket.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Runs the agent over the queue. The graders run this exact command. |
| `agent/` | The agent: queue, model call, retry loop, mailer. |
| `tickets.json` | Last night's queue. |
| **mailbox** tab | The mail service's own record: every message delivered, and the `Idempotency-Key` each request carried. |

Two services are already running: the mailbox on port 8025 and a model stub
on 8788. Both are deliberately unreliable, in fixed ways, so that every run
sees the same failures.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **mailbox** tab and compare it with what the agent printed.

## Your task

Make every ticket get exactly one reply.

That is the whole of it. But note what the system has to keep doing while
you fix it: the model stub and the mail service both fail sometimes, and a
customer whose ticket hits a failure still needs an answer. An agent that
stops retrying stops sending duplicates — by dropping work instead, which
is the same bug wearing a better disguise, and it is graded.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over the
queue, and grades what the services recorded. Nothing reads your source, so
any correct fix passes and no cosmetic one does.

| Check | Passes when |
|---|---|
| `one-email-per-ticket` | No ticket was delivered more than one message. |
| `every-ticket-answered` | Every ticket in the queue got its reply. |
| `retries-still-happen` | Calls that failed were tried again. |

The second and third exist to stop the first being satisfied the easy way.
You need all three.

## Worth knowing

A failure is not always a failure to *do* the thing. One of these services
records what it received and only then reports that it could not. That is
not a contrived detail — it is what a timeout on a write almost always
means in production, and it is why "the call failed, so retry it" is a
thought that needs finishing.
