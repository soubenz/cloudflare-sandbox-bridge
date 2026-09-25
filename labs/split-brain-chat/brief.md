# Two replicas, two different conversations

The billing desk is a chat agent. Customers write in about charges they do not
recognise, refunds, cancellations; for each turn the desk works out what it
has on file for that customer, answers, and does whatever the turn asks it to
do with the payments provider.

It used to be one process. Two weeks ago it was scaled to two replicas behind
a router, because one was not keeping up. Since then support has been
collecting complaints that do not quite make sense, and which of them a
customer gets seems to depend on nothing at all. Customers are asked for their
account number twice in the same conversation. Replies come back that have
clearly not read the turn before — one customer wrote *"it forgot what I told
it thirty seconds ago"*. And Priya Raghunathan, who wrote in because she had
been *charged twice* for September, has now been *refunded twice* and would
like to know which one she is allowed to keep.

The desk's own output looks fine. It reports every turn answered and does not
sound alarmed.

## What you have

| Where | What |
|---|---|
| `run_agent.py` | Starts the desk (two replicas and the router), drives the conversations through it, stops it again. The graders run this exact command. |
| `agent/` | The desk: the router, one replica, the store client, the payments client, the process that starts them, and the traffic. |
| `transcripts.json` | This morning's conversations, seven of them, turn by turn. |
| **transcript** tab | The store's own record: every conversation as one thread, which replica wrote each row, and what the desk claimed to know when it wrote it. |

Two services are running, started by the lab and not by you: the conversation
store on port 8851 and the payments provider on 8852. Both are deliberately
unreliable, in fixed ways, so that every run sees the same failures. The
replicas and the router are *not* services — `run_agent.py` starts them on
8853-8855 and stops them when it finishes. A run you interrupt leaves them
holding those ports, and the next run will not start; `curl -XPOST
127.0.0.1:8853/api/quit` (and 8854, 8855) clears them.

Start here, in the **Terminal**:

```bash
python3 run_agent.py
```

Then open the **transcript** tab and read one conversation from the top.

## Your task

Make every conversation read back as one conversation.

That is the whole of it. But note what the desk has to keep doing while you
fix it.

Both replicas have to keep taking turns. The obvious way to stop a
conversation being split between two processes is to stop splitting it — send
each customer to the replica that started them, and the forgetting goes away.
So does the reason there are two replicas: a pinned conversation cannot
survive its replica going away, which is the one thing scaling to two was
supposed to cover. That is graded.

And a customer who asked for one refund has to get one refund. A turn that
failed still has to be finished, and finishing it must not mean doing it
again. Priya's second refund did not come from a bug in the arithmetic; it
came from a turn being started over. That is graded too, and it is the one
that does not go away when the forgetting does.

## Checking your work

**Run checks** resets both services, runs *your* `run_agent.py` over
`transcripts.json`, and grades what the services recorded. The conversation
comes from the store, which is the only thing that saw all of it. The side
effects come from the payments provider, which is the thing that carried them
out. Nothing reads your source, so any correct fix passes and no cosmetic one
does.

| Check | Passes when |
|---|---|
| `continuity-holds-across-replicas` | Every turn is in the thread exactly once, and no reply was written knowing less than the customer had already said. |
| `side-effects-happen-exactly-once` | Every turn that asked the provider for something got it done once — including the turns that were retried. |
| `both-replicas-take-turns` | Both replicas answer turns, and conversations are not pinned to one of them. |

The second and third exist to stop the first being satisfied the easy way.
You need all three.

## Worth knowing

Losing the connection to a payments provider tells you nothing about whether
the money moved. The instruction is read, carried out and written to the
provider's ledger, and only then does the provider decide what the caller
gets to hear — so a refund that comes back as a timeout is a refund that
happened, and a refund that comes back as nothing at all is usually one too.
This is not a contrived detail; it is what any write over a network means. It
is also why "the call failed, so try the turn again" is a sentence that needs
finishing, and why the only reference you can be sure of knowing again later
is one you chose yourself and wrote down somewhere that is not in the process
making the call.
