# See why a document matched

Nothing is broken here. This is a tour of a real retrieval service: a small
houseplant-care FAQ, embedded and stored in Postgres with pgvector, and a
query service in front of it that traces every search to Phoenix. You run
queries, read the real scores that come back, and look at a real trace to
see exactly what was retrieved and why.

## What is running

| Service | What it is doing |
|---|---|
| `postgres` | A real Postgres 14 with the pgvector extension, holding 24 short houseplant-care documents, each with a real vector embedding |
| `phoenix` | Arize Phoenix, a real AI-observability tool. Every search is traced here as an OpenInference RETRIEVER-kind span: the query, every document that came back, and its real score |
| `app` | The query service: embeds your text, runs a real pgvector cosine-distance search, sends the trace, and returns the ranked results |
| **phoenix-view** tab | Phoenix's own UI, proxied so it works as a tab. This is where you read the trace |

The embedding here is not a real language model -- it is a small,
deterministic function (`workspace/services/embedding.py`) that turns text
into a vector by hashing character fragments of its words. It is stable
(the same text always gives the same vector) and it produces meaningfully
different vectors for different content, which is all a lesson about
reading pgvector's own scores needs. Don't read anything into the exact
numbers beyond "closer means more word-fragment overlap" -- that's the
whole mechanism.

## Start here

```bash
python3 -B query.py "How often should I water my succulents?"
```

This prints every result with its real distance (0 = identical direction,
larger = further apart) and similarity score (1 - distance). Now compare it
against a near-duplicate phrasing of the same question:

```bash
python3 -B query.py "What's the watering schedule for a succulent plant?"
```

Notice the top result is the same document both times, even though barely
any words are shared word-for-word -- and that the distances for the
*rest* of the ranking shift around it. That's the actual mechanism this
lab is about: pgvector doesn't know anything about succulents, it only
ever measures how close two vectors are.

## Look at a real trace

Open the **phoenix-view** tab. In the left sidebar, open the `default`
project, then click on a `retrieve_documents` span from one of the calls
you just made. Its attributes list holds the query you sent
(`input.value`), and, for every document that came back,
`retrieval.documents.<i>.document.id`, `.content`, and `.score` -- the
exact same numbers query.py printed, straight from the same span the app
service actually emitted.

## Optional: pgvector's own index

```bash
python3 -B explain_query.py "How often should I water my succulents?"
```

This runs the same search directly in Postgres and prints Postgres's own
`EXPLAIN` plan for it, twice: once letting the planner choose freely, and
once with sequential scans disabled, forcing it to use the real
`documents_embedding_hnsw` index that's built over this table. With only 24
documents in this corpus, the planner usually picks a plain sequential scan
on its own -- an index has overhead of its own, and there's nothing here
big enough to make it worth paying. The forced run shows the index is real
and does get used; the unforced run shows the planner correctly deciding it
isn't worth it yet at this size.

## Answer these

1. Run `python3 -B query.py "How often should I water my succulents?"`.
   What is the `id` of the top result?
2. Using that same query's results, how many documents came back with a
   distance below **0.72**?
3. Run `python3 -B query.py "What's the boiling point of tungsten in
   Kelvin?" --top-k 24` (nothing in this corpus is about tungsten or
   boiling points). Does *any* result come back with a distance below
   **0.65**?

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "top_match_id": null,
  "close_match_count": null,
  "out_of_corpus_has_close_match": null
}
```

Replace each `null`: the first with the document id (a string), the second
with a number, the third with `true` or `false`.

## Checking your work

| Check | Passes when |
|---|---|
| `services-are-up` | The app, Phoenix, and the phoenix-view tab all report healthy, and a real query returns real results |
| `answers-match-the-service` | Your three answers match what the live service actually reports right now |

The second check makes its own calls to the app with the exact same two
queries above and reads its own results back -- it never looks at your
source, and it never depends on which queries you personally ran first.
