# Offer teams a retrieval service they do not have to build

Three teams -- `acme`, `globex`, `northwind` -- share one document store
behind pgvector. Each team wants the same thing from it: ask a question in
its own words, get back its own team's most relevant documents, ranked by
how close they actually are to the question, and never see anything that
belongs to a different team, no matter how similar it looks.

That service doesn't work yet. `platform/main.py`'s `POST /search`
endpoint is running, and it does filter by tenant -- just take a close
look at when.

## What you have

| Where | What |
|---|---|
| `platform/main.py` | Your task. `POST /search {tenant_id, query, top_k}` -> `{"results": [...]}`. Its docstring says exactly what has to be true of what it returns; the implementation underneath doesn't do that yet. |
| `platform/embedding.py` | Given, not part of your task. `embed(text) -> list[float]` and `vec_literal(vec) -> str` -- turns text into the same kind of vector already sitting in Postgres's `embedding` column, and turns a python vector into something you can pass into a `::vector` cast. |
| Postgres | A `chunks` table: `tenant_id`, `doc_id`, `title`, `content`, `embedding` (a pgvector column), already loaded with a small multi-tenant corpus at session boot. `POSTGRES_URL` is in your environment. |
| **app** tab | The one thing you must not touch. Sends real tenant-scoped questions to your `/search` endpoint on a timer and shows what came back -- including a plain red flag if a result ever belongs to a different tenant than the one that asked. |

You can talk to Postgres directly too (`psql "$POSTGRES_URL"`) to see the
corpus for yourself, and to your own `/search` endpoint with `curl` once
you restart `platform` from the console's Services panel.

## Your task

Make `POST /search` actually behave like a multi-tenant retrieval service:

1. **Never return another tenant's documents.** Not even one that happens
   to sit closer to the query in embedding space than anything the
   caller's own tenant has -- and some genuinely do; the corpus was built
   that way on purpose, the same way a real shared document store risks
   it.
2. **Rank by real vector similarity, within that tenant.** The point isn't
   "return something" -- it's the actual nearest documents to the query,
   among the ones that tenant owns.

Watch the **app** tab for a few cycles before you start. It rotates
through one question per tenant, forever, against your current endpoint --
if any row ever turns red, that call returned a document belonging to a
different tenant than the one that asked.

## Checking your work

**Run checks** never reads your code. For each check, it starts its own
copy of `platform/main.py` against a fresh, private database (seeded with
an identical copy of the same corpus), and calls it the same way any real
caller would -- your terminal, `psql`, and the `app` tab are never touched
by grading.

| Check | Passes when |
|---|---|
| `tenant-isolation-is-real` | A search scoped to one tenant never returns a document belonging to a different tenant -- tested against a case built to be a genuinely close call in embedding space, not an easy one. |
| `recall-works-within-a-tenant` | For a query only one tenant has anything relevant to, that tenant's actual top-k nearest documents come back -- compared against the database's own true answer, computed independently, not just "some non-empty list". |
| `filtering-happens-in-the-query-not-after` | For a query where *other* tenants' documents are closer to it than the requesting tenant's own, that tenant's true top-k still comes back. A "fetch the closest documents across everyone, then keep this tenant's" implementation gets this one wrong even though it never leaks -- it just quietly returns too little. |

The third check exists because the first two can both look satisfied by
an implementation that filters *after* asking the database for its top-k,
instead of *as part of* asking for it. That distinction only shows up when
other tenants' documents are close enough to crowd the real ones out of a
small limit -- which is exactly what happens on this corpus.
