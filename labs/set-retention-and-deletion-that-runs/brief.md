# Set retention and deletion that actually run

A customer asks you to delete their data. On this platform, one customer's
data doesn't live in one place -- it lands in three real stores every time
they use the product:

| Store | What's in it | Where |
|---|---|---|
| **Trace/span store** | Real span rows for every request a customer's traffic generated: which service handled it, how long each step took, token counts, cache hits | a SQLite database, `$TRACE_DB_PATH` |
| **Export bundle** | A per-customer data-export file (the kind of thing a "download my data" button would hand back), plus an index file listing who currently has one | `$EXPORT_DIR`, indexed at `$EXPORT_INDEX_PATH` |
| **Cache** | Cached embeddings and cached responses, written while serving that customer's requests | a SQLite database, `$CACHE_DB_PATH` |

Three customers already have real data seeded into all three stores. You
can see who, right now:

```sh
curl -s $RETENTION_API_URL/customers
```

And you can check any one customer's actual footprint across all three
stores at once -- this sweeps the real trace store, the real cache and the
real export directory + index every time you call it, live:

```sh
curl -s $RETENTION_API_URL/customers/cust_4471/audit
```

## Your task

`/workspace/retention/delete_customer.py` is supposed to delete every trace
of one given customer from all three stores when you run it:

```sh
python3 -B /workspace/retention/delete_customer.py cust_4471
```

Run it, then check `$RETENTION_API_URL/customers/cust_4471/audit` again.
Something about the result is wrong -- either that customer isn't as gone
as the script claims, or something else changed that shouldn't have. Read
`delete_customer.py`, figure out what's actually happening in each of the
three stores, and fix it so that:

- Deleting a customer removes **every** trace of them from **all three**
  stores -- the trace/span store, the cache, and the export bundle *and*
  its index entry. A customer who's still listed in the index, or still
  has one row anywhere, hasn't been deleted.
- Deleting one customer **never** touches any other customer's data, in
  any of the three stores. Check the other seeded customers before and
  after you run your fix -- all of their data should be untouched.

## Checking your work

| Check | Passes when |
|---|---|
| `retention-api-is-up` | The retention-api service is reachable |
| `target-customer-fully-deleted` | After running your `delete_customer.py` against `cust_4471`, a direct sweep of all three stores finds nothing left of that customer |
| `other-customers-are-intact` | Every other seeded customer's data in all three stores is exactly what it was before your script ran |
| `deletion-is-auditable` | An independent sweep of the three stores, and the live retention-api's own `/customers` and `/customers/{id}/audit` endpoints, all agree that the deleted customer is gone and every other customer is still there |

Every check re-derives the truth by reading the three real stores directly
(or by asking the live retention-api, which does the same) -- never by
reading your source code, and never against a fixed answer key.
