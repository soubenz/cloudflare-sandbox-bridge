---
id: gateway.routing-aliases
title: Model aliases and routing
minutes: 3
recap: An alias is the stable name callers send; the gateway's config maps it to a real deployment, and the provider's own log shows where a call really went.
---
Larkfield's teams never write a provider model name in their code. They call the gateway and send an alias, `support` or `fast`, in the `model` field. The gateway looks that name up and decides where the call goes. The caller never has to know, and never has to change when the answer changes.

The mapping lives in the gateway's config. In this lab it is `gateway/config.yaml`, and each entry has the same three parts:

```yaml
model_list:
  - model_name: support        # the alias a caller sends
    litellm_params:
      model: openai/fake-model # the model the provider is asked for
      api_base: http://127.0.0.1:8961/X/v1   # where the call is sent
```

Two entries can name different aliases and still point at the same provider. Here the provider is one process with two deployments, and a deployment is just a different path under the same host. The `X` above is that path, so the `api_base` line is what makes one alias mean one deployment and another alias mean another.

This gives you three things worth having. You can repoint an alias to a new model or provider and no application changes. Provider keys and provider-specific names stay out of every team's repo. And there is one place to read to see what an alias means.

One trap. Whatever the response says about the model is weak evidence of routing, because it is not a record of where the call ended up. The provider on the far side is the witness that cannot be wrong, because it keeps its own log of every call it received, with the deployment that received it.

In the lab, `send_calls.py` prints the deployment that answered by reading that provider log, and the **view** tab shows the same log as a table. To answer "which deployment does an alias route to", you can read the config, or you can make a call and watch what the provider recorded. Doing both and checking they agree is the habit to build.
