---
id: rag.close-matches
title: Close matches and score thresholds
minutes: 3
recap: A search returns its top-k rows however far away they are; a distance threshold is what decides which rows count as close.
---
A vector search answers "what are the k nearest documents?" It does not answer "which documents are relevant?". Those are different questions, and the gap between them is where wrong citations come from.

::diagram[rag-close-matches]

Look at how the app is built. `top_k` defaults to 8, so a plain query returns eight rows, ranked. The ranking is relative: row one is closer than row two. Whether row one is actually close is a fact about its **distance**, an absolute number you have to read for yourself.

A **threshold** turns the ranking into a decision. Pick a line, say distance below 0.72, and everything under it counts as a close match while everything over it is noise. In this lab you are handed that line, so answering "how many documents are close" is a matter of counting rows under it. Two habits help:

- Ask for the whole corpus, not only the default. `--top-k 24` returns every document, so you can see where the distances stop being close instead of guessing.
- Compare rows by distance, not by position. Two rows can sit one place apart in rank and a long way apart in score.

Try a paraphrase of a query, too. Reword the same question and the top document usually stays put, but distances move for the whole list. A document just under a threshold on one phrasing can sit just over it on another. That is why a threshold is a tuning decision: teams set it by running known-good and known-bad queries and looking at where the numbers fall, then revisit it whenever the embedding model changes.

In the lab, run the succulent query from the brief, then a reworded version, and set the two result tables side by side. Watch the closest row, then the rows near the line.
