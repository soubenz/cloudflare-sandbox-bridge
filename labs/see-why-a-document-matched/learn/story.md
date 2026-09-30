---
title: The answer that sounded right
minutes: 2
---
It is Thursday, a little after eleven. Priya Nair from Support forwards you a ticket with one line of her own on top: "The assistant cited the wrong article again. It read fine. That is the problem."

A customer had asked one thing and the assistant answered from a document about something next door. Nothing crashed and nothing looked odd in the logs. The retrieval step returned documents, the model wrote a fluent reply from them, and nobody could say how close those documents had really been.

Maren Osei stops by your desk. "Before you touch Support's real index, learn to read what a retrieval service is telling you. Tomasz set up a small sandbox for exactly this. It is a houseplant-care FAQ, 24 short documents, stored in Postgres with pgvector. The query service in front of it sends every search to Phoenix as a trace, so you can see what came back and with what score."

Tomasz Wieland leans in from the next desk. "I kept the embedding function tiny and deterministic on purpose. It is not a real language model, so do not judge quality by it. It is there so the same text gives the same numbers every time. Sorry about that. It was the only way to make a lesson repeatable."

Maren gives you the shape of the task. Ask the service one question and find out which document it puts first. Count how many documents sit close enough to that question to be worth citing, using the 0.72 line Support has been using. Then ask it something the FAQ has nothing about, and find out whether anything comes back closer than 0.65, or whether the service just hands over the least bad option.

"Three answers, written down," she says. "Priya wants to know whether her problem is the model or the search. You will need the numbers to say."
