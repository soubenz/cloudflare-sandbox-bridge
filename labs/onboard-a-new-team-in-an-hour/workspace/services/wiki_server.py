#!/usr/bin/env python3
"""The docs/wiki team's own MCP tool server. Built and deployed on its own,
before there was any platform gateway.

One tool: `search_wiki`, backed by a small fixed document set.

Env:
  WIKI_HOST  default 127.0.0.1
  WIKI_PORT  required
"""
import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("WIKI_HOST", "127.0.0.1")
PORT = int(os.environ["WIKI_PORT"])

mcp = FastMCP("wiki", host=HOST, port=PORT)

_DOCS = {
    "onboarding": "New teammates: your platform credentials live in platform/onboarded/<team>/.",
    "shipping": "Standard shipping takes 3-5 business days.",
    "vacation": "Request time off at least two weeks in advance.",
}


@mcp.tool()
def search_wiki(query: str) -> dict:
    """Search the fixed internal document set by keyword."""
    query = query.strip().lower()
    hits = [
        {"title": title, "snippet": body}
        for title, body in _DOCS.items()
        if query in title or query in body.lower()
    ]
    return {"query": query, "hits": hits}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
