---
id: sovereignty.declared-vs-actual
title: Declared region versus actual region
minutes: 3
recap: To check a residency property, compare every region tag observed on a real trace against the region the deployment is declared to be in.
---
A residency claim has two halves. The **declared** region is what a deployment is configured to be: the `region` under its `model_info`. The **actual** region is what a real request touched, which you read from the trace. Proving a property means putting the two side by side, request by request.

In this lab each service that handles a request tags its own span with `opalix.region`. The gateway does not tag itself, and other spans may carry nothing. So the procedure is:

1. Send a request and find its trace, using the response id.
2. Open every span and list each `opalix.region` value you see, along with the service it came from.
3. Fetch the alias's declared region from `/v1/model/info`.
4. Compare. The property holds only if every observed tag matches the declared region. One tag that differs means the request left the region, however the alias is labelled.

Some pitfalls to avoid.

Do not stop at the last span. A request can pass through a middle service in one region on its way to a provider in another. The final span alone would hide it, so look at all the tagged spans.

Do not read untagged spans as containment. A span with no tag says nothing. You have only proved what is tagged.

Do not compare against the alias name. `support-` followed by a region is a naming convention, not the declared region. The field in `model_info` is the source of truth for the declaration.

Remember what a tag is. Each service reports its own region about itself. It is stronger evidence than a config file, because it comes from the service that handled the data, but it is still self-reported. For a stronger audit you would also check the network path or the provider's own log.

The lab asks you to run this comparison twice: once to name the region a single-hop route reached, and once to decide whether every tag on the multi-hop route agrees with its declaration. Do the work on fresh requests, because the grader will.
