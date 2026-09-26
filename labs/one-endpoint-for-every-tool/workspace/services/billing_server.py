#!/usr/bin/env python3
"""The billing team's own MCP tool server.

Two tools, built and deployed by billing with no platform involved:

  - `charge_lookup` -- read-only, safe for anyone with a reason to check a
    charge. This is the one meant to end up reachable through the gateway.
  - `refund_charge` -- moves money. Billing built it for their own on-call
    engineers, never for general use, and it must stay off any bundle that
    a normal caller can reach. Nothing about the wire format marks it as
    dangerous; a virtual server bundles it, or it doesn't, on purpose.

Env:
  BILLING_HOST  default 127.0.0.1
  BILLING_PORT  required
"""
import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("BILLING_HOST", "127.0.0.1")
PORT = int(os.environ["BILLING_PORT"])

mcp = FastMCP("billing", host=HOST, port=PORT)

_CHARGES = {
    "ch_1001": {"amount": 42.50, "status": "settled"},
    "ch_1002": {"amount": 9.99, "status": "settled"},
    "ch_1003": {"amount": 120.00, "status": "refunded"},
}


@mcp.tool()
def charge_lookup(charge_id: str) -> dict:
    """Look up the amount and status of a charge by id. Read-only."""
    charge = _CHARGES.get(charge_id)
    if charge is None:
        return {"charge_id": charge_id, "found": False}
    return {"charge_id": charge_id, "found": True, **charge}


@mcp.tool()
def refund_charge(charge_id: str, amount: float) -> dict:
    """Issue a refund against a charge. On-call/admin use only -- this
    moves real money and was never meant to be reachable by a general
    caller."""
    charge = _CHARGES.get(charge_id)
    if charge is None:
        return {"charge_id": charge_id, "found": False, "refunded": False}
    charge["status"] = "refunded"
    return {"charge_id": charge_id, "found": True, "refunded": True, "amount": amount}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
