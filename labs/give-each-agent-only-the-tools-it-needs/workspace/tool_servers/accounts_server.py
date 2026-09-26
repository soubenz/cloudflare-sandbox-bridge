"""The accounts tool server: reader, writer, AND one admin-only tool.

`get_account` only reads. `issue_refund` is a bounded write -- it can move
money, but it cannot destroy anything. `delete_account` is this lab's one
true admin tool: irreversible, and nobody but an admin token should ever
be able to reach it -- not by a prompt telling an agent "don't call this",
but because the gateway itself refuses the call for any token that isn't
scoped to it.

Run it directly while working on the rest of the lab:

    python3 -B tool_servers/accounts_server.py

Nothing here is broken and nothing needs fixing -- this file (and its two
siblings in this folder) are the fixture the lab is built on, not the task.
"""
import os

from mcp.server.fastmcp import FastMCP

PORT = int(os.environ.get("ACCOUNTS_TOOL_PORT", "4747"))
mcp = FastMCP("accounts-server", host="0.0.0.0", port=PORT)

_ACCOUNTS = {
    "acct-1": {"owner": "a. borrower", "balance": 42.00, "deleted": False},
}


@mcp.tool()
def get_account(account_id: str) -> dict:
    """Return one account's record."""
    return _ACCOUNTS.get(account_id, {})


@mcp.tool()
def issue_refund(account_id: str, amount: float, reason: str) -> dict:
    """Issue a refund against an account's balance."""
    acct = _ACCOUNTS.get(account_id)
    if not acct:
        return {"ok": False, "error": "not found"}
    acct["balance"] -= amount
    return {"ok": True, "new_balance": acct["balance"]}


@mcp.tool()
def delete_account(account_id: str) -> dict:
    """Permanently delete an account. Admin-only: irreversible.

    This is the one tool in this whole lab that a non-admin role must
    never be able to reach -- not "should not", must not, and "must not"
    has to be something the gateway itself enforces.
    """
    acct = _ACCOUNTS.get(account_id)
    if not acct:
        return {"ok": False, "error": "not found"}
    acct["deleted"] = True
    return {"ok": True}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
