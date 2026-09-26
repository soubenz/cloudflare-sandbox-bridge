"""Give every team a budget that actually holds.

LiteLLM's own per-team `max_budget` (set on the team via `/team/new`) is
real, but a burst of calls can still carry a team past it before anything
refuses. Run send_calls.py against the `research` team to see it.

Your job: refuse a call *before* it is sent to the model whenever this
team's own spend, plus what this call could cost in the worst case, would
put the team over its budget -- so a team's calls are held to its budget
across a burst, not just eventually true after the fact.

This file is wired up already (see gateway/config.yaml's
`litellm_settings.callbacks`), and it runs. Right now it does nothing:
`async_pre_call_hook` always returns `None`, which tells LiteLLM "let this
one through, no objection from me" -- so untouched, this lab behaves
exactly like a bare LiteLLM proxy with only the built-in `max_budget` set.

Some things worth knowing before you start:

  - `user_api_key_dict` (the argument below) carries `team_id`,
    `team_spend` and `team_max_budget`.
  - Refusing a call from here means raising `litellm.HTTPException` (or
    returning an error string that becomes the response body) -- returning
    `None` always waves the call through.
  - The alias's price is set in config.yaml (`model_info` on the
    `assistant` model). Mirror it below rather than trying to look it up
    from LiteLLM's internals at request time -- keep the two in sync.
  - `data` is the incoming request body: `data["model"]`, `data["messages"]`,
    and, when the caller sent one, `data["max_tokens"]`.
"""

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth

# Keep in sync with gateway/config.yaml's `model_info` for the
# `assistant` alias.
INPUT_COST_PER_TOKEN = 0.001
OUTPUT_COST_PER_TOKEN = 0.001


class BudgetGuard(CustomLogger):
    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache,
        data: dict,
        call_type: str,
    ):
        # TODO: estimate this call's worst-case cost (a prompt-token
        # estimate, plus the completion tokens it could use, priced at the
        # constants above), compare it against this team's budget and
        # whatever it has already committed to spending, and refuse (raise
        # or return an error) when the two together would go over.
        #
        # A refusal should name the team, its current spend, and its
        # budget, so whoever hits it knows why.
        return None


budget_guard_instance = BudgetGuard()
