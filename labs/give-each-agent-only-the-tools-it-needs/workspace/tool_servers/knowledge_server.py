"""The knowledge-base tool server: read-only.

An MCP tool server built on the official `mcp` SDK's `FastMCP` helper, the
same one ContextForge itself is built on. Both tools here only ever read;
neither one changes anything. This is the "reader" tool server the
catalogue's design calls for -- every role in this lab is allowed to see
both of these tools.

Run it directly while working on the rest of the lab:

    python3 -B tool_servers/knowledge_server.py

Nothing here is broken and nothing needs fixing -- this file (and its two
siblings in this folder) are the fixture the lab is built on, not the task.
"""
import os

from mcp.server.fastmcp import FastMCP

PORT = int(os.environ.get("KNOWLEDGE_TOOL_PORT", "4745"))
mcp = FastMCP("knowledge-server", host="0.0.0.0", port=PORT)

_KB = {
    "kb-1": "Reset a password: Settings > Security > Reset.",
    "kb-2": "Refund policy: refunds are allowed within 30 days of purchase.",
    "kb-3": "Escalation policy: anything a customer disputes past 30 days goes to an ops agent, not support.",
}


@mcp.tool()
def search_kb(query: str) -> list:
    """Search the knowledge base and return matching article ids."""
    q = query.lower()
    return [aid for aid, text in _KB.items() if q in text.lower()]


@mcp.tool()
def get_kb_article(article_id: str) -> str:
    """Return the full text of one knowledge base article."""
    return _KB.get(article_id, "not found")


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
