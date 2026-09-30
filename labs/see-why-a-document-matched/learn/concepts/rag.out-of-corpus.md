---
id: rag.out-of-corpus
title: Questions the corpus cannot answer
minutes: 3
recap: A search always returns something, even when nothing is relevant; only the scores can tell you the corpus has no answer.
---
Ask a vector search anything and it returns k rows. There is no empty result and no "I do not know", because the database only sorts by distance. If the corpus holds nothing relevant, you get the nearest irrelevant documents.

That is the failure Priya described. The assistant asked for context, retrieval handed over its top result, and the model wrote a fluent answer from it. A top-1 with no distance check looks the same to the model whether it is a strong match or the least bad option.

A question outside the corpus, an **out-of-corpus query**, is how you find out which of the two your service does. The test is simple. Ask something the documents cannot answer, request the whole corpus with `--top-k 24`, and look at the best distance in the list rather than at what is ranked first. Ranked first is always something. What matters is how far away it is.

Two cautions:

- A toy embedding, and to a lesser degree a real one, can find a nearish document by coincidence. A word fragment in common is not shared meaning. So look at the number, then read the text it points at.
- A threshold has to be chosen for the model in use. The line that separates close from far for one embedding function tells you nothing about another.

The remedy is a guard in the service: if no row is under the threshold, return nothing, or say so, instead of passing the top row on. Building that guard comes later. The skill for now is reading the evidence.

In the lab, use the tungsten question from the brief, request all 24 documents, and check whether anything crosses the line the brief gives. The trace in the `phoenix-view` tab lists the same rows and scores if you prefer to read them there.
