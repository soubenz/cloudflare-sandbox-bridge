# Quickstart: your first call through the shared gateway

Welcome to the platform. Every team talks to models through one shared
LiteLLM gateway instead of holding provider credentials directly. This
page is the whole onboarding: get a key, make a call, confirm you're
scoped the way you think you are. `$LITELLM_URL` and `$LITELLM_MASTER_KEY`
are already in your shell's environment -- you don't need to look them up.

## 1. Get a key for your team

```bash
RESPONSE=$(curl -s -X POST "$LITELLM_URL/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"key_alias\": \"onboarding-team-key-$$\", \"models\": [\"team-chat\"]}")
echo "$RESPONSE"
export TEAM_KEY=$(echo "$RESPONSE" | python3 -c 'import sys, json; print(json.load(sys.stdin)["key"])')
```

You'll see a JSON object printed. It has a `"key"` field that starts with
`sk-`, and a `"models"` field that is exactly `["team-chat"]` -- that's the
only alias this key can ever reach. The last line saves that key into
`$TEAM_KEY` for the rest of this session.

## 2. Make your first call

`team-chat` is the one alias every team is granted by default.

```bash
curl -s -X POST "$LITELLM_URL/chat/completions" \
  -H "Authorization: Bearer $TEAM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "team-chat", "messages": [{"role": "user", "content": "hello from the quickstart"}]}'
```

This is staging, not a live model -- you should see
`"content": "reply from deployment a"` come back in `choices[0].message`,
and the top-level `"model"` field will echo `"team-chat"`. If you see
words other than that, something about this gateway's current setup has
drifted from what this page says.

## 3. Confirm you're actually scoped

There's a second alias, `platform-internal`, reserved for the platform
team's own tooling. No team key is ever granted it -- including yours.

```bash
curl -s -o /dev/null -w '%{http_code}' -X POST "$LITELLM_URL/chat/completions" \
  -H "Authorization: Bearer $TEAM_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "platform-internal", "messages": [{"role": "user", "content": "hello"}]}'
```

This prints a single HTTP status code with nothing else. It should be
`403` -- your key was never given `platform-internal`, so the gateway
refuses it. If this ever prints `200` instead, someone gave a team key more
reach than it should have.

That's the whole quickstart. If any of the three things above stop being
true, `docs/verify_docs.py` is what's supposed to catch it before the next
team wastes an afternoon on a doc that used to be right.
