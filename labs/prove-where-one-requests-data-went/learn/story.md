---
title: Where did it go?
minutes: 2
---
Dr. Anneke de Vries writes to the platform channel at ten past nine, and she does not use exclamation marks.

A customer in the Support team's queue has asked Larkfield, in writing, where the data in one of their tickets was processed. The customer's contract names a region. Anneke has to reply this week, and she wants the reply to rest on something better than a sentence in a config file.

"I do not doubt the routing rules," she says when you call. "I have read them. I would like to see the request itself. If you can show me where one went, I can sign my name under it."

Maren Osei has already pointed her at you. Tomasz Wieland sends a short note with the lab details: the gateway serves three regional aliases, `support-us`, `support-apac` and `support-eu`, each declared to sit in its own region. He adds a warning. "I remember the EU one is not a straight line to its provider. There is something in the middle. I never wrote down what."

You have the gateway, a tracing backend, and the gateway's own log of every call it has served. There is a small script to send a real request through any alias.

Anneke wants three things pinned down. Where a request sent through the US alias actually ended up. How many separate services touched a request sent through the EU alias, counting the gateway itself. And whether every region marker on the EU request agrees with the region the EU alias is declared to be in.

"Answer from what happened," she says, "not from what was meant to happen. I will ask how you know."
