"""The relay's ledger of what each tenant has spent.

One call, ``charge(tenant, cost)``, answers the only question the relay
needs answered before it forwards anything: can this tenant afford this
request right now. It is checked before the call leaves the container, the
same way a provider's own context-window check would refuse a request that
is too big rather than start sending it -- refusing here is free and
refusing after the call would not be.

A tenant's balance is its own. Nothing that happens on one tenant's account
is supposed to change what another tenant can still spend, which is why the
balance is kept per tenant rather than as one number for everyone.
"""

import threading

from .config import TENANT_BUDGET_TOKENS

_lock = threading.Lock()

# What each tenant has spent so far this run. A tenant's own spend only
# grows on a call that was actually admitted for *that tenant* -- a refused
# call changes nothing, so a tenant that is momentarily over its own budget
# can still be admitted for something small enough to fit in what is left,
# and nothing here ever looks at any other tenant's number.
_spent = {}


def charge(tenant, cost):
    """Tries to spend ``cost`` tokens on ``tenant``'s own account.

    Returns (admitted, spent_after, budget) whether or not the charge went
    through, so the caller can always say what that tenant's balance is.
    """
    with _lock:
        spent_so_far = _spent.get(tenant, 0)
        if spent_so_far + cost > TENANT_BUDGET_TOKENS:
            return False, spent_so_far, TENANT_BUDGET_TOKENS
        _spent[tenant] = spent_so_far + cost
        return True, _spent[tenant], TENANT_BUDGET_TOKENS


def reset():
    with _lock:
        _spent.clear()
