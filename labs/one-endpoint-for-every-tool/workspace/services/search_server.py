#!/usr/bin/env python3
"""The search team's own MCP tool server.

One tool, `search_docs`, over a tiny fixed set of fake documents. Built and
deployed by the search team on its own, same as inventory and billing --
three teams, three servers, three ports, and no shared front door.

Env:
  SEARCH_HOST  default 127.0.0.1
  SEARCH_PORT  required
"""
import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("SEARCH_HOST", "127.0.0.1")
PORT = int(os.environ["SEARCH_PORT"])

mcp = FastMCP("search", host=HOST, port=PORT)

_DOCS = [
    {"id": "doc-1", "title": "Return policy", "text": "Returns are accepted within 30 days of purchase."},
    {"id": "doc-2", "title": "Shipping times", "text": "Standard shipping takes 3 to 5 business days."},
    {"id": "doc-3", "title": "Warranty terms", "text": "Widgets carry a one year limited warranty."},
]


@mcp.tool()
def search_docs(query: str) -> list:
    """Search the fixed document set for a query string, matching against
    title and text (case-insensitive substring match)."""
    q = query.strip().lower()
    return [d for d in _DOCS if q in d["title"].lower() or q in d["text"].lower()]


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
