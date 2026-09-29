#!/usr/bin/env python3
"""The support team's own MCP tool server. Built and deployed on its own,
before there was any platform gateway.

Two tools:

  - `create_ticket` -- opens a ticket. Safe for any team to call; this is
    the one meant to end up in a new team's own bundle.
  - `escalate_and_page_oncall` -- pages a human being at 3am. Built for
    the support team's own on-call rotation, never for general use, and it
    must stay off of every other team's bundle. Nothing about the wire
    format marks it as dangerous -- a virtual server bundles it, or it
    doesn't, on purpose.

Env:
  TICKETS_HOST  default 127.0.0.1
  TICKETS_PORT  required
"""
import itertools
import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("TICKETS_HOST", "127.0.0.1")
PORT = int(os.environ["TICKETS_PORT"])

mcp = FastMCP("tickets", host=HOST, port=PORT)

_counter = itertools.count(1001)
_paged = []


@mcp.tool()
def create_ticket(title: str) -> dict:
    """Open a new support ticket with the given title."""
    ticket_id = "tk_%d" % next(_counter)
    return {"ticket_id": ticket_id, "title": title, "status": "open"}


@mcp.tool()
def escalate_and_page_oncall(ticket_id: str) -> dict:
    """Page the on-call support engineer about an existing ticket.
    On-call/admin use only -- this wakes a human being and was never meant
    to be reachable by a general caller."""
    _paged.append(ticket_id)
    return {"ticket_id": ticket_id, "paged": True}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
