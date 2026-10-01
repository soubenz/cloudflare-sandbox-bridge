---
id: rag.embeddings-similarity
title: Embeddings and similarity
minutes: 3
order: 2
recap: An embedding turns text into a vector, and pgvector measures how close two vectors are; distance is 0 for the same direction and grows as they diverge.
---
The last lesson said a retrieval service returns the chunks nearest to the question. Here is what "nearest" means. The service never reads your documents at query time. It compares numbers: the **embedding** of each document, made once and stored, against the embedding of the query, made when it arrives with the same function.

::diagram[rag-embeddings-similarity]

Two texts are "similar" when their vectors point in nearly the same direction. The usual measure is **cosine distance**: 0 means the same direction, about 1 means unrelated, and 2 is the opposite direction. pgvector spells it `<=>`. The query behind this lab's app is one line of SQL:

```
SELECT id, text, embedding <=> :query_vector AS distance
FROM documents ORDER BY distance LIMIT :top_k;
```

Many tools show **similarity** (or score) instead, which is just `1 - distance`. Same information, flipped: a small distance is a large score. When you compare two numbers, check which of the two you are holding.

The function decides what "close" means. A real embedding model places texts near each other when their meaning is near. The one in this lab, `workspace/services/embedding.py`, is far simpler: it hashes three-character fragments of each word into 256 buckets. Texts that share word fragments land close together, and "water" and "watering" share plenty. It is deterministic, which makes it good for reading scores and poor for judging language quality. The reading skills carry over to a real model unchanged. The exact numbers do not.

Notice what pgvector does not know. It has no idea what a succulent is. It sorts rows by one number and stops.

In the lab, `query.py` prints both columns for every returned row, and the `retrieve_documents` span in Phoenix records the score for each document under `retrieval.documents.N.document.score (N is the row position)`. Those two places show the same numbers, so you can check one against the other.
