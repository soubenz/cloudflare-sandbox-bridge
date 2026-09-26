"""Fake in-memory order dataset for this lab.

Not a database -- just a fixed Python list your tool server reads from
directly. 55 rows, so a page of 10 needs 6 calls to walk the whole thing
(the last page is partial), which is exactly the case a "just return
everything" pagination stub gets wrong.
"""

_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"]
_CUSTOMERS = [
    "Ada Reyes", "Ben Okafor", "Chie Tanaka", "Dov Ellis", "Elin Svensson",
    "Farid Haidari", "Grace Lin", "Hana Novak", "Ivo Petrov", "Jana Kovac",
]


def _make_orders(n: int) -> list[dict]:
    orders = []
    for i in range(1, n + 1):
        orders.append(
            {
                "id": i,
                "customer": _CUSTOMERS[i % len(_CUSTOMERS)],
                "status": _STATUSES[i % len(_STATUSES)],
                "total_cents": 500 + (i * 137) % 9000,
            }
        )
    return orders


ORDERS: list[dict] = _make_orders(55)
