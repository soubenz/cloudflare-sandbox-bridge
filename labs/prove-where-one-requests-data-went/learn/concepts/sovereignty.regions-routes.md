---
id: sovereignty.regions-routes
title: Regions and routes
minutes: 3
recap: A region is a label a deployment claims, and a route is the path from an alias to wherever the request really goes.
---
Callers of the gateway never name a region. They name an alias, such as `support-eu`, and the gateway decides where the request goes. Two ideas are involved, and they are easy to confuse.

::diagram[sovereignty-regions-routes]

A **route** is the path a request takes: alias, then a deployment, then the address that deployment calls (its `api_base`), then whatever sits behind that address. In this lab, `gateway/config.yaml` defines three aliases. Each one is a deployment of the same fake model with its own address. Two aliases point straight at a regional provider. One points at a regional proxy first.

A **region** is a fact about a deployment that someone wrote down. LiteLLM has no built-in idea of a region. You attach one yourself as free-form fields under a deployment's `model_info`. This lab uses `region`, `data_residency_zone` and `opalix_hop_count`. The gateway serves those fields back verbatim from `GET /v1/model/info`, so you can read them from the running system:

```bash
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://127.0.0.1:4000/v1/model/info
```

Notice what that gives you. It is the declared region: what the platform team says about the deployment. A label does not move data and nothing forces it to be true. An alias could be labelled with one region and address a service in another, and the label would still read fine.

That is why Larkfield's rules are stated as routes. The EU is the default. The US is allowed for some routes only. A rule like that constrains which alias a team may use, but Anneke's question is about a single request, and only that request's own record shows what happened.

Two habits make this clean. Keep the declared value and the observed value apart, and name which you are quoting. And read the label live rather than trusting the config file, because the config on disk and the config the gateway loaded can differ.

In the lab, send a request through each alias with `send_request.py`, and read the declared region for each alias from the model info. Keep that output. You will compare against it in a later step.
