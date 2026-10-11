---
title: The front door for every model call
minutes: 2
---
Last Tuesday, a customer asked our support assistant a simple question. Then they waited. By the time the reply arrived, they'd typed "hello?" three times, and the third one was in capitals.

To find where that time went, you first need to know how our apps reach a model. They never call the provider, the company that runs the model, themselves. Every call goes through one front door that we run, called the AI gateway. Tomasz describes it as a hotel front desk: you ask the desk, and the desk knows who to call.

We didn't always have one. Each team used to keep its own key for its provider, and one of those keys ended up in a chat screenshot that got eleven thumbs up. Then Support's provider went down in the middle of the night. Its name was written into their code, so moving to another provider meant Tomasz editing that code at three in the morning.

Now the keys live in the gateway and nowhere else. When a provider fails, the gateway sends the call to another one and no app has to change. It also writes down every call that goes through it, so Jonas in Finance can finally see which team spent what.

Back to our customer. Their question went in through the gateway and touched three more parts. The model wrote the reply. The vector store found our help articles. The cache checked whether we'd answered something like it recently.

Each part keeps its own log. Tomasz read all four for an hour. Every line said the request went fine, and not one of them said how long the customer had been sitting there. Everyone says ok; nobody says slow.

So the gateway also keeps a trace of each request. It's like a parcel tracking page: every stop on one page, with when it arrived and how long it stayed. In a trace, each stop is called a span.

That customer's request has a trace waiting for you in Jaeger, our trace viewer. Find the slowest step, and add up the tokens, the bits of text the model charges for. Then find what the cache lookup sits under.
