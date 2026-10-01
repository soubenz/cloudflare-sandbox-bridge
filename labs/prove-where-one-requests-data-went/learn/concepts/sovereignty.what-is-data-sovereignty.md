---
id: sovereignty.what-is-data-sovereignty
title: What data sovereignty means for an AI request
minutes: 3
order: 1
recap: A prompt is data, and where it is processed can be limited by contract or law; proof of where it went is the audit trail of every hop it took.
---
Dr. de Vries's question sounds legal, but for you it is a plain engineering one: where did this customer's text go, and can you show it?

**A prompt is data.** When a Support agent asks a model to draft a reply, the ticket goes into the prompt: the customer's name, their order, their complaint. The model runs on a provider's machines, which read that text and may log it. So every AI request moves personal data to some place, and which place matters.

**Residency and sovereignty.** **Data residency** means the data stays in an agreed place, such as the EU. **Data sovereignty** means the data is subject to the laws of the place where it is processed. A customer's contract can say "processed in the EU only", and data protection rules can say the same. Break that and you have a contract or legal problem even if the answer was perfect.

**Region, route, hop**

- A **region** is a named place a deployment runs, such as `eu` or `us`.
- A **route** is the path an alias takes: from the alias the caller names, to a deployment, and on to whatever sits behind it.
- A **hop** is every service the request passes through on that path: the gateway, any proxy in the middle, the provider. Each hop handles the data, so one hop in the wrong region breaks the promise, even if the last one is fine.

::diagram[sovereignty-what-is-data-sovereignty]

**Declared versus actual.** The **declared** region is what the platform team wrote down for a deployment, for example "this alias is in the EU". The **actual** region is where a real request went. A declaration is a promise. Nothing forces it to match what happened.

**Why an audit trail.** An auditor cannot sign a promise. An **audit** needs a record made while the request ran, listing each hop and the region it reported. In this lab two such records exist, the gateway's own log and a trace, and they do not show the same amount. Later lessons say how they differ.

**In the lab.** Three aliases each claim their own region. You send real requests through them, then read the trace in Jaeger and the log in Postgres to answer three questions: which region a request reached, how many services touched it, and whether every region tag agrees with the declared one. Answer from what happened, not from what was meant to happen.
