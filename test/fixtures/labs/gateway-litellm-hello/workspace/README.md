# LiteLLM gateway smoke test

Three services run in this container:

- **postgres** on :5432, backing LiteLLM's virtual keys, teams and spend
  tracking. No browsable UI.
- **provider** on :8961, a scripted stand-in for a model, with two
  deployments (`a` and `b`) that each log every call they get. No browsable
  UI.
- **litellm** on :4000, the gateway itself. Its admin UI always requires a
  login (username `admin`, password the master key), so under this lab's
  no-login rule it is not proxied as a tab either — use it with `curl`,
  same as any code calling it would.

`$LITELLM_URL`, `$PROVIDER_URL` and `$LITELLM_MASTER_KEY` are already in
your environment. See `gateway/config.yaml` for how the two aliases
(`support`, `fast`) map onto the provider's two deployments.
