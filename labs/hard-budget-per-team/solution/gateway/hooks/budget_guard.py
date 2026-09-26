"""Reference solution for labs/hard-budget-per-team.

Refuses a call, before it is sent anywhere, whenever this team's own
committed spend plus this call's worst-case cost would put it over budget.
Keeps its own running total per team rather than trust anything the
gateway itself reports (see manifest.yaml's header comment and
docs/spike.md's LiteLLM section for why that number is stale for tens of
seconds, not milliseconds) -- and updates that total the moment a call is
admitted, not after it finishes, so a burst of concurrent calls can't all
see the same stale total and all fit.
"""
import threading

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import ProxyErrorTypes, ProxyException, UserAPIKeyAuth

# Keep in sync with workspace/gateway/config.yaml's `model_info` for the
# `assistant` alias.
INPUT_COST_PER_TOKEN = 0.001
OUTPUT_COST_PER_TOKEN = 0.001


def _estimate_prompt_tokens(messages):
    if not messages:
        return 0
    last = messages[-1].get("content", "")
    return len(str(last).split())


class BudgetGuard(CustomLogger):
    def __init__(self):
        super().__init__()
        # A plain lock, not an asyncio one: everything under it is
        # synchronous (no `await`), so it only ever guards a few
        # dictionary operations and can never deadlock a coroutine.
        self._lock = threading.Lock()
        # team_id -> running total of worst-case cost this process has
        # committed to and not yet reconciled to the call's real cost.
        self._committed: dict[str, float] = {}

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache,
        data: dict,
        call_type: str,
    ):
        team_id = user_api_key_dict.team_id
        team_budget = user_api_key_dict.team_max_budget
        if team_id is None or team_budget is None:
            return None  # no team, or no budget set on it -- nothing to enforce

        prompt_tokens = _estimate_prompt_tokens(data.get("messages") or [])
        max_tokens = data.get("max_tokens") or 0
        worst_case_cost = prompt_tokens * INPUT_COST_PER_TOKEN + max_tokens * OUTPUT_COST_PER_TOKEN

        with self._lock:
            already_committed = self._committed.get(team_id, 0.0)
            if already_committed + worst_case_cost > team_budget:
                raise ProxyException(
                    message=(
                        "Budget has been exceeded! Team=%s Current cost: %.6f, "
                        "Estimated request cost: %.6f, Max budget: %.6f"
                        % (team_id, already_committed, worst_case_cost, team_budget)
                    ),
                    type=ProxyErrorTypes.budget_exceeded,
                    param=None,
                    code="429",
                )
            # Reserve it now, synchronously, before yielding control back --
            # the whole point is that the next call in a concurrent burst
            # must see this reservation, not the total from before this one.
            self._committed[team_id] = already_committed + worst_case_cost
            data.setdefault("metadata", {})["budget_guard_reservation"] = {
                "team_id": team_id,
                "reserved": worst_case_cost,
            }
        return None

    def _reconcile(self, kwargs, actual_cost):
        metadata = (kwargs.get("litellm_params") or {}).get("metadata") or {}
        reservation = metadata.get("budget_guard_reservation")
        if not reservation:
            return
        team_id = reservation["team_id"]
        reserved = reservation["reserved"]
        with self._lock:
            current = self._committed.get(team_id, 0.0)
            # Swap the worst-case reservation for what the call actually
            # cost -- a completion that used fewer tokens than its
            # `max_tokens` frees the difference back up for the next call.
            self._committed[team_id] = max(0.0, current - reserved + actual_cost)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        actual_cost = kwargs.get("response_cost") or 0.0
        self._reconcile(kwargs, actual_cost)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        # The call never reached (or was never billed by) the model --
        # release the reservation entirely rather than charging for it.
        self._reconcile(kwargs, 0.0)


budget_guard_instance = BudgetGuard()
