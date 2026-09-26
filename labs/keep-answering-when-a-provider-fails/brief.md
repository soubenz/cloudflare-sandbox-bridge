# Keep answering when a provider fails

Customer support runs every request through one model alias, `support`,
on the LiteLLM gateway in front of it. It has always pointed at a single
upstream deployment. That deployment has outages -- rare ones, but real
ones -- and right now, when it's down, `support` is down: every customer
request just fails.

## What you have

- `gateway/config.yaml` -- the `support` alias's config, exactly as it's
  configured this morning. After you change it, restart `litellm` from
  the **Services panel** (left side) so it picks up your edit -- editing
  the file alone doesn't restart the running process.
- `outage.py` -- a way to see the failure yourself, on demand:
  `python3 outage.py on` starts an outage of the primary deployment,
  `python3 outage.py slow` makes it answer but only after a long delay,
  and `python3 outage.py off` ends whichever of those is running.
- `traffic.py` -- sends a stream of ordinary customer requests to
  `support` and prints what happened to each one, including which
  deployment actually answered it.
- The **view** tab -- a live, read-only look at what the fault proxy in
  front of the primary deployment did with every attempt it received,
  and which deployment actually served every call the provider itself
  received.
- The scripted provider answers on two separate paths, `a` and `b` --
  the same process, two different deployments. `support` reaches `a`.
  `b` is reachable too, directly, and it is not having an outage.

(Paths above are relative to `/workspace`, which is where your terminal
starts.)

## What "fixed" looks like

Run `python3 outage.py on`, then `python3 traffic.py 20 0.3` in another
terminal. Today, every one of those twenty requests fails. Once you're
done:

- **Every request still gets a real answer**, the whole time the primary
  deployment is down -- not an occasional one.
- **The primary deployment gets an actual rest during the outage.** It
  should end up being asked for well under half of the requests that
  came in while it was down, not something close to every single one.
- **No single request should struggle to get there.** One request
  shouldn't need more than a couple of tries against a deployment that
  just told it no, and it shouldn't take more than a few seconds either
  way.
- **The primary comes back on its own.** Turn the outage off
  (`python3 outage.py off`) and, within 30 seconds of that, traffic
  should find its way back to the primary deployment with nothing for
  you to do by hand -- and once it's back, it should be handling nearly
  all of the traffic again, the way it did before the outage.

None of this is about hiding the outage from anyone watching -- the view
tab stays honest about which deployment answered what, and how many
times the failing one was asked at all while it was down. The point is
that a customer never has to find out there was one.
