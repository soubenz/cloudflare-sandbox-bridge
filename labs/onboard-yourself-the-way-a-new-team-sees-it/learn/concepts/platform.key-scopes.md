---
id: platform.key-scopes
title: Key scopes and legacy aliases
minutes: 3
recap: A key can only call the aliases on its team's models list, and a refusal is a real 401 or 403, so test the boundary instead of assuming it.
---
A gateway key does two jobs. It identifies the caller, and it limits what the caller may use. The limit is a list of model aliases. Every alias not on the list is refused, even when the alias exists and works perfectly for someone else.

Think of Larkfield's Support team, holding an alias called `support`. Search holds `fast`. A Search key that asks for `support` is not sent to a different model or downgraded. It gets an error back, and the error names which list said no. LiteLLM reports `key_model_access_denied` when the key's own list refuses, and `team_model_access_denied` when the team's list does.

Where the list lives matters. In this lab, the new team is created with a `models` list, and its key is generated with only a team id. A key made that way inherits the team's list. It has no list of its own, so it cannot drift from the team's. If you gave a key its own separate list, you would have two places to keep in step.

A **legacy alias** is one that older teams still use and nobody has retired. Legacy aliases are where scoping goes wrong in practice, because a new team's setup is often copied from an old team's. Copying a whole models list brings the old aliases along. Scoping to the alias a team actually asked for is the safe default, and the way to know it worked is to try the boundary.

That is what to look for in the lab. `onboard.py` step 5 makes one call the new key should be allowed and one it might not be, and prints the HTTP status of each on its own line. A refusal is a 401 or 403. A grant is a 200. The status is the evidence, not the config.

You can also see it on the view tab. The left side lists teams, their keys and the aliases each may use. Compare the list for the pre-existing team with the list for the new one. The aliases themselves are defined in `gateway/config.yaml`; a team's grant is a separate record.

One caution: the view tab never shows a usable key. Do not try to read one from there. The script saves the new key in `onboard_state.json` in the workspace, and that is the file to use if you want to call the gateway yourself with `curl`.
