# See why a document matched

Nothing is broken here. This is a tour of a real retrieval service: a
houseplant-care FAQ in Postgres with pgvector, and a query service that traces
every search to Phoenix.

## What is running

| Service | What it is doing |
|---|---|
| `postgres` | Postgres 14 with pgvector, holding 24 short houseplant-care documents, each with a vector embedding |
| `phoenix` | Arize Phoenix, which receives one trace per search |
| `app` | The query service: embeds your text, runs the pgvector search, returns ranked results |
| **phoenix-view** tab | Phoenix's UI, where you read the trace |

The embedding is a small deterministic function
(`workspace/services/embedding.py`), not a language model. The same text
always gives the same vector.

## Start here

```bash
python3 -B query.py "How often should I water my succulents?"
python3 -B query.py "What's the watering schedule for a succulent plant?"
```

Each row shows a distance (0 is the same direction, larger is further) and a
score (1 minus distance). Compare the two runs.

## Look at a trace

In the **phoenix-view** tab, open the `default` project and click a
`retrieve_documents` span. Its attributes hold your query (`input.value`) and,
per document, `retrieval.documents.<i>.document.id`, `.content` and `.score`.

## Optional: the index

`python3 -B explain_query.py "How often should I water my succulents?"` prints
Postgres's `EXPLAIN` plan for the same search, with and without the
`documents_embedding_hnsw` index forced.

## Answer these

The questions are in the **Questions** tab, next to this brief. Answer them there; your answers are saved for you.

The questions use two queries:

- the succulent query: `python3 -B query.py "How often should I water my succulents?"`
- the tungsten query: `python3 -B query.py "What's the boiling point of tungsten in Kelvin?" --top-k 24`
