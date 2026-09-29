# Hints

These are the same three hints the session sends you automatically, timed
to roughly 15%, 30% and 45% of the way through your session -- they're
just written here too since this file is visible from the start. Try to
hold off reading ahead of where you actually are.

## Hint 1 (~15%)

Run `curl -s $RETENTION_API_URL/customers/cust_4471/audit | python3 -m
json.tool` before and after running your script. It sweeps the trace
store, the cache and the export directory + index directly, so it will
tell you exactly which of the three still has something in it -- you
don't have to guess from delete_customer.py's own printed count.

## Hint 2 (~30%)

Once cust_4471 itself is genuinely gone from all three stores, check the
OTHER seeded customers too: `curl -s $RETENTION_API_URL/customers`. If one
of them has vanished as a side effect, look at exactly how
delete_customer.py decides whether a stored row, cached entry or export
file "belongs to" the customer you're deleting -- and what two different
customer ids can look like to that exact same comparison.

## Hint 3 (~45%)

`"cust_44718".startswith("cust_4471")` is `True`. A customer id is an
opaque identifier to compare for exact equality, not a namespace prefix --
fix the one helper every deletion routine shares so it matches customer
ids exactly, in all three stores and in the export index.
