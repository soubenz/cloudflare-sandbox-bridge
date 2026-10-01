---
title: Where did it go?
minutes: 2
---
At ten past nine, Anneke in data protection wrote to our platform channel. No greeting, no exclamation marks. When Anneke skips the exclamation marks, I put my coffee down.

A customer has asked us, in writing, where the data in one of their support tickets was processed. Their contract names a region, and Anneke has to sign the reply this week.
Our first instinct was to send her the routing rules. But Anneke has already read them, twice, with a pen, and a rule only says what we meant to happen. She wants to see what actually happened to one real request.

Then Tomasz remembered something awkward. Our gateway serves three regional aliases, one each for the US, Asia-Pacific and the EU, and each is declared to sit in its own region. The EU one isn't a straight line to its provider. Something sits in the middle, and he never wrote down what. "In my defence," he said, "it worked."

Here's the good news. Every request through our gateway leaves a trace: a record written while it runs by each service that touches it. The gateway also keeps its own log of every call it sends, and a small script sends a real request through any alias.

So that's your job today. Send real requests, open their traces, read what each hop says about itself, and hold it up against what we declared. Pin down three things: where a request through the US alias really ended up, how many services touched one through the EU alias, counting the gateway itself, and whether every region tag on that EU request agrees with the region we declared for it.

Anneke will ask how you know. Answer from what happened, not from what was meant to happen.
