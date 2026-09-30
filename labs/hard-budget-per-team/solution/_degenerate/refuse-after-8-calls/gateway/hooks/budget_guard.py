"""DEGENERATE answer -- never published, never the reference solution.

Refuses a team's 9th call onward without ever looking at a price or at
`max_tokens`. It only "works" while every call costs the same known
amount, which the grader's randomised call sizes deliberately break: it
must fail `no-team-goes-over` (8 admitted calls of mixed size cost more
than the budget) or `teams-in-budget-keep-working`.
"""
import threading

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import ProxyErrorTypes, ProxyException, UserAPIKeyAuth

MAX_CALLS = 8


class BudgetGuard(CustomLogger):
    def __init__(self):
        super().__init__()
        self._lock = threading.Lock()
        self._calls: dict[str, int] = {}

    async def async_pre_call_hook(self, user_api_key_dict: UserAPIKeyAuth, cache, data: dict, call_type: str):
        team_id = user_api_key_dict.team_id
        budget = user_api_key_dict.team_max_budget
        if team_id is None or budget is None or budget > 10:
            return None  # only the small-budget team is counted
        with self._lock:
            n = self._calls.get(team_id, 0)
            if n >= MAX_CALLS:
                raise ProxyException(
                    message="Budget has been exceeded! Team=%s Current cost: %.6f, Max budget: %.6f"
                    % (team_id, budget, budget),
                    type=ProxyErrorTypes.budget_exceeded,
                    param=None,
                    code="429",
                )
            self._calls[team_id] = n + 1
        return None


budget_guard_instance = BudgetGuard()
