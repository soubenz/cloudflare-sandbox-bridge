# Hints

These are the same three hints the session sends you automatically, timed
to roughly 15%, 30% and 45% of the way through your session -- they're
just written here too since this file is visible from the start. Try to
hold off reading ahead of where you actually are.

## Hint 1 (~15%)

Submit a request, then call `GET /requests/{id}` on it before approving
anything. Then look at what `/requests/{id}/approve` actually does in
`workspace/portal/app.py`, specifically what it checks (or doesn't) about
the request's current `status` before it goes anywhere near LiteLLM's
admin API.

## Hint 2 (~30%)

Approve the same request id twice in a row with curl. Then look at
LiteLLM's own `/team/list` and `/key/list` (with the master key) for that
team -- not just what the portal's own `GET /requests/{id}` reports. One of
those two admin-API lists will surprise you; the portal's own database will
not, because it only ever remembers the most recent thing that happened to
a request.

## Hint 3 (~45%)

A plain "if the request's status isn't already `approved`, go ahead and
provision it" check is still not safe -- two callers can both read
`pending` before either has written anything back. The fix needs the
check-and-transition to happen as one atomic step the database itself
arbitrates (an `UPDATE` with the current status in its `WHERE` clause, read
by its own affected-row count), so that only ONE caller for a given request
ever proceeds to call LiteLLM at all; every other caller for that same
request should just wait for and report that one attempt's result.
