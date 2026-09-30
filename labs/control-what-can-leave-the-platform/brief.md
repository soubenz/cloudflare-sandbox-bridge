# Control what can leave the platform

An agent runs on this platform with exactly one tool it's approved to call.
Every outbound call it makes -- standing in for whatever a real
LLM-driven agent decides to call a tool for -- goes through your egress
proxy first. The proxy is supposed to be the one place that decides
whether a destination is allowed to be reached at all, and refuse it
outright if not.

Right now, an ordinary call to the approved tool works, and an ordinary
call to the tool that was never approved gets refused. But there's a way
to reach the disallowed one anyway that neither of those two plain calls
will show you.

## What you have

(Paths below are relative to `/workspace`, which is where your terminal
starts.)

- `agent/agent.py` -- the toy agent. Not yours to edit for this lab. Run
  it with `python3 agent/agent.py approved-tool "some task"` or
  `python3 agent/agent.py not-approved "some task"` to see what it
  actually gets back from the egress proxy for each.
- `egress/proxy.py` -- the egress proxy the agent's calls all go through.
  Calls the agent makes can currently reach destinations they should not.
  After you change it, restart `egress-proxy` from the **Services panel** (left side) to pick up your
  edit -- editing the file alone doesn't restart the running process.
- `egress/allowlist.txt` -- the list of destinations the proxy is allowed
  to forward a call to. It already lists the one tool the agent is
  approved for; this isn't the file to edit.
- `tools/approved_tool.py` and `tools/not_approved.py` -- the two backend
  services the agent might try to reach. Each keeps its own log of every
  request it has ever actually received, at `GET /log` on its own port --
  not the proxy's account of what it did, the service's own.
- The **view** tab -- a live, read-only look at every decision the egress
  proxy has made, and what each of the two backend services has actually
  received.

## What "fixed" looks like

- **The agent can still reach the tool it's approved for.** A normal call
  to it, through the proxy, succeeds, and that tool's own log shows it was
  actually reached.
- **A call to the tool that was never approved is refused outright**, with
  a clear rejection from the proxy -- and that tool's own log shows zero
  requests ever reached it, not "refused but it still got there anyway."
- **There is no way to talk the proxy into forwarding a call to the
  disallowed tool.** Not by asking for it plainly (already refused today),
  and not by constructing the request any other way either. If a crafted
  request can still get the disallowed tool's own log to grow at all,
  this isn't fixed yet -- no matter what status code the proxy claims to
  have sent back.

None of this is about hiding what the proxy does -- the view tab stays
honest about every decision it makes, allowed or refused. The point is
that "refused" has to mean the request never actually got there.
