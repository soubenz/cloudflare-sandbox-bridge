---
title: The front door for every model call
minutes: 2
---
Last Tuesday, a customer asked our support assistant a simple question, and then waited. By the time the reply came, they had typed "hello?" three times.

To find where that time went, start with how our apps reach a model. They never call the model company directly. Every request goes through one front door that we run. That door is the AI gateway. Tomasz likes to compare it to a hotel front desk: you ask the desk, and the desk knows who to call.

We didn't always have one. Each team kept its own key for its provider, the company that runs the model, and one of those keys ended up in a screenshot in the team chat. Then Support's provider went down in the middle of the night. The provider's name was written into their code, so switching meant rewriting that code at three in the morning.

Now the keys live in one place, the gateway. If a provider goes down, the gateway sends the request to another one, and the apps don't change. It also keeps a record of every request, which is how Finance can finally see which team spent what.

Back to our customer. Their question went through the gateway and then to three more parts. A model, which writes the answer. A vector store, which finds our help articles. And a cache, which remembers recent answers.

Each part keeps its own log. Tomasz read all four for an hour. Every line said the request went fine. None of them said how long the customer had waited. Everyone says ok; nobody says slow.

So the gateway also keeps a trace of each request. Think of a parcel tracking page: every stop on one page, with when it arrived and how long it stayed. Each stop in a trace is called a span.

That customer's request has a trace waiting in Jaeger, our trace viewer. Find the step that took longest. Add up the tokens, the pieces of text a model charges for. Then find what the cache lookup sits under.
