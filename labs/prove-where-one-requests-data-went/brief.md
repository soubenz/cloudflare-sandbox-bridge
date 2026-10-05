# Prove where one request's data went

Nothing is broken; this is a tour. Send real requests, then prove from the system's own trace and log, not from a config file, where the data actually went.

## What is running

| Service | What it is |
|---|---|
| **litellm** | The gateway, with three aliases: `support-us`, `support-apac`, `support-eu`. Each is tagged with a `region` under `model_info`. |
| **jaeger** tab | Every call is traced here, from the gateway to wherever the request ends up. No login. |
| Postgres | LiteLLM's own log of each call, in the table `LiteLLM_SpendLogs`. |

`support-us` and `support-apac` route straight to their own provider. `support-eu` goes through a regional proxy first.

## Send a request

```bash
python3 -B /workspace/send_request.py support-eu "a question a customer asked"
```

Note the response `id`. It is the `opalix.response_id` on the final provider span in Jaeger and the `request_id` in the spend log:

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -c \
  "select request_id, model_group, api_base from \"LiteLLM_SpendLogs\" where request_id = '<the id you got back>';"
```

In Jaeger, use **Find Traces** with service `opalix-litellm`, open the trace nearest your request, and expand every row. The declared regions come from:

```bash
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://127.0.0.1:4000/v1/model/info
```

## Answer these

The questions are in the **Questions** tab, next to this brief. Answer them there; your answers are saved for you.

Send one request through `support-us` and one through `support-eu`, and answer from what their traces show right now.

## Checking your work

| Check | Passes when |
|---|---|
| `services-are-up` | LiteLLM and Jaeger are reachable and all three aliases report a live region |
| `answers-match-live-traces` | Your answers match fresh requests through `support-us` and `support-eu`, checked live against Jaeger and the spend log |
