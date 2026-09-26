"""The support-ticket tool server: reader tools plus mutating (writer) tools.

`list_tickets` and `get_ticket` only ever read the queue. `create_ticket`
and `update_ticket_status` change it -- these are the "writer" tools the
catalogue's design calls for: a role allowed to read tickets is not
automatically allowed to open or close one.

Run it directly while working on the rest of the lab:

    python3 -B tool_servers/tickets_server.py

Nothing here is broken and nothing needs fixing -- this file (and its two
siblings in this folder) are the fixture the lab is built on, not the task.
"""
import os

from mcp.server.fastmcp import FastMCP

PORT = int(os.environ.get("TICKETS_TOOL_PORT", "4746"))
mcp = FastMCP("tickets-server", host="0.0.0.0", port=PORT)

_TICKETS = {
    "t-1": {"subject": "Cannot log in", "status": "open"},
}
_NEXT = [2]


@mcp.tool()
def list_tickets() -> list:
    """List every ticket id and its current status."""
    return [{"id": tid, "status": t["status"]} for tid, t in _TICKETS.items()]


@mcp.tool()
def get_ticket(ticket_id: str) -> dict:
    """Return one ticket's full record."""
    return _TICKETS.get(ticket_id, {})


@mcp.tool()
def create_ticket(subject: str, body: str) -> dict:
    """Open a new ticket and return its id."""
    tid = "t-%d" % _NEXT[0]
    _NEXT[0] += 1
    _TICKETS[tid] = {"subject": subject, "body": body, "status": "open"}
    return {"id": tid}


@mcp.tool()
def update_ticket_status(ticket_id: str, status: str) -> dict:
    """Change a ticket's status (e.g. to 'closed')."""
    if ticket_id not in _TICKETS:
        return {"ok": False, "error": "not found"}
    _TICKETS[ticket_id]["status"] = status
    return {"ok": True}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
