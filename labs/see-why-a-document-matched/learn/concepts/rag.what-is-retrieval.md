---
id: rag.what-is-retrieval
title: What retrieval is and why a model needs it
minutes: 3
order: 1
recap: Retrieval finds the few chunks of your documents nearest to a question, with scores, and hands them to a model that has never read those documents.
---
A language model knows what it learned in training. It has never read Larkfield's support articles, and you cannot paste all of them into every request: the **context window**, the amount of text a model can read at once, is limited, and every extra page costs money and attention. So something has to fetch the few pages that matter before the model answers. That step is **retrieval**, and the service that does it is the knowledge service Priya's assistant calls.

Think of a librarian. You ask a question. They do not hand you the library, and they do not read it aloud. They go to the shelves, come back with three marked pages and tell you how well each one fits. You write the answer from those pages. If the pages are wrong, your answer will be too, however well you write.

::diagram[rag-what-is-retrieval]

A retrieval service works in six steps:

1. Each document is split into **chunks**, short passages. In this lab each of the 24 FAQ entries is short enough to be one chunk.
2. Each chunk goes through an **embedding** function, which turns text into a list of numbers, a vector. Texts about similar things get similar numbers.
3. The vectors are stored in a database, here Postgres with pgvector. The whole set of stored documents is the **corpus**.
4. When a question arrives, it is embedded with the same function.
5. The store returns the nearest chunks, each with a **similarity score**, and **top-k** is how many it returns. Some tools show a distance instead, which is the same information flipped: small distance, high score.
6. The service passes those chunks and the question to the model, which writes its answer from them.

Notice what the service never does. It does not read the chunks and decide they are good. It ranks the corpus by closeness to the question and stops. Whether a ranked chunk is actually relevant is something you read from the numbers, and that is what this lab teaches.

In the lab you will send questions to a small houseplant-care service and read what comes back: which document ranks first, how many sit close enough to be worth citing, and what happens when you ask about something the FAQ does not cover. The next lessons explain the scores and the thresholds you will use.
