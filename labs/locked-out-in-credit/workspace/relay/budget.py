"""The relay's ledger of what each tenant has spent.

One call, ``charge(tenant, cost)``, answers the only question the relay
needs answered before it forwards anything: can this tenant afford this
request right now. It is checked before the call leaves the container, the
same way a provider's own context-window check would refuse a request that
is too big rather than start sending it -- refusing here is free and
refusing after the call would not be.

A tenant's balance is its own. Nothing that happens on one tenant's account
is supposed to change what another tenant can still spend.
"""

import threading

from .config import TENANT_BUDGET_TOKENS

_lock = threading.Lock()

# What has been spent so far this run. A tenant's spend only grows on a call
# that was actually admitted -- a refused call changes nothing, so a tenant
# that is momentarily over budget can still be admitted for something small
# enough to fit in what is left.
_spent = 0


def charge(tenant, cost):
    """Tries to spend ``cost`` tokens on ``tenant``'s account.

    Returns (admitted, spent_after, budget) whether or not the charge went
    through, so the caller can always say what the balance actually is.
    """
    global _spent
    with _lock:
        if _spent + cost > TENANT_BUDGET_TOKENS:
            return False, _spent, TENANT_BUDGET_TOKENS
        _spent += cost
        return True, _spent, TENANT_BUDGET_TOKENS


def reset():
    global _spent
    with _lock:
        _spent = 0
