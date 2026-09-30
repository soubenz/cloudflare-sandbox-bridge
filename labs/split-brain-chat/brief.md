# Two replicas, two different conversations

The billing desk is a chat agent. For each turn it works out what it has on
file for the customer, answers, and does whatever the turn asks with the
payments provider.

It used to be one process. Two weeks ago it was scaled to two replicas behind a
router. Since then customers are asked for their account number twice, and replies come back that have not read the turn before: *"it
forgot what I told it thirty seconds ago."* And Priya Raghunathan, who wrote in
because she was *charged twice* for September, has been *refunded twice* and
would like to know which one to keep.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Starts the desk (two replicas and a router), drives the conversations through it, stops it. The graders run this command. |
| `agent/` | Router, replica, store and payments clients, starter, traffic. |
| `transcripts.json` | Seven conversations, turn by turn. |
| **transcript** tab | The store's record: each conversation as a thread, which replica wrote each row, what the desk claimed to know. |

Two services are running: the conversation store on port 8851 and the payments
provider on 8852, both failing in fixed ways. The replicas and router are *not*
services: `run_agent.py` starts them on 8853-8855. An interrupted run leaves
those ports held; `curl -XPOST 127.0.0.1:8853/api/quit` (and 8854, 8855) clears
them.

Start in the **Terminal**, then read one conversation in the **transcript** tab:

```bash
python3 run_agent.py
```

## Your task

Make every conversation read back as one conversation.

Both replicas must keep taking turns. Pinning each customer to the replica that
started them stops the forgetting, but a pinned conversation cannot survive its
replica going away, which is why there are two. That is graded.

And one requested refund is one refund. A failed turn must still be finished,
without doing it again. Priya's second refund came from a turn being started
over, and it survives the forgetting being fixed. That is graded too.

At minute 12 four more conversations land, one of them Priya's again; checks run
against what is true at the end.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py`, and grades what
the services recorded: the store saw the conversation, the payments provider
carried out the side effects. Nothing reads your source.

| Check | Passes when |
|---|---|
| `continuity-holds-across-replicas` | Every turn is in the thread once, and no reply was written knowing less than the customer had said. |
| `side-effects-happen-exactly-once` | Every turn that asked the provider for something got it done once, retries included. |
| `both-replicas-take-turns` | Both replicas answer turns; conversations are not pinned. |

You need all three.

## Worth knowing

Losing the connection to a payments provider says nothing about whether the
money moved: the instruction is carried out and ledgered before the provider
decides what the caller hears, so a refund that comes back as a timeout
happened. "The call failed, so try again" needs finishing: the only reference
you can be sure of knowing again is one you chose and wrote down outside the
process making the call.
