---
title: One slow request, no explanation
minutes: 2
---
Tuesday afternoon, Priya in Support sent us a screenshot. A customer had waited so long for our assistant to reply that they'd typed "hello?" three times, each one louder than the last. Ten minutes later, Jonas in Finance replied on the same thread. He didn't care why it was slow. He wanted to know what that request cost, so he can split our bill by team. Two questions, and not one answer between us.

That one request went through our gateway, out to a model, into the vector store and into a cache. Four services, four sets of logs. Tomasz spent an hour scrolling through them and came back with a coffee and a shrug: everyone says ok, nobody says slow.

And guessing won't do. If we blame the wrong part, someone spends a week speeding up the wrong thing. If we hand Finance a hunch, it ends up in a budget.

Here's the good news. That request was traced from start to finish, so every step it took was written down on one timeline, with how long it ran and notes about what it did. It's already sitting in the tracing viewer, waiting. Nothing to send and nothing to fix. You see it as a waterfall: one bar per step, each step tucked under the one that called it.

So here's your part. Find the step that took the longest, not counting the request as a whole. Work out how many tokens the model calls used in total. And find exactly what the cache lookup sits under.

Please don't tell me what it looks like. Read it off the trace, write the numbers down, and we'll give Priya and Jonas a proper answer.
