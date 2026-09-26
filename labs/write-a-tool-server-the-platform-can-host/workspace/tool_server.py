"""Your MCP tool server. Complete it -- see brief.md for the full task.

This uses the official `mcp` Python SDK's FastMCP helper, the same package
ContextForge itself is built on. `@mcp.tool()` reads your function's type
hints and turns them into the tool's real JSON Schema `inputSchema` --
that's what "typed inputs" means here, and it is why order_id below is
already declared `int` rather than left as a bare, untyped parameter.

Run it directly while you work on it:

    python3 -B tool_server.py

Edits to this file are NOT picked up automatically. This service is
started fresh from the Services panel -- restart it there any time you
change this file, including if a bad call ever takes the process down
while you're testing it by hand.
"""
import os

from mcp.server.fastmcp import FastMCP

from dataset import ORDERS

PORT = int(os.environ.get("TOOL_SERVER_PORT", "8990"))
mcp = FastMCP("orders-tool-server", host="0.0.0.0", port=PORT)


@mcp.tool()
def get_order(order_id: int) -> dict:
    """Look up a single order by its id.

    BUG: this treats order_id as a position in the ORDERS list, not as
    the order's own "id" field -- so most ids return the WRONG order
    silently, and an id past the end of the list blows up with a raw
    Python error instead of a clean one.

    Fix it to look orders up by their real id, and to fail cleanly (a
    real MCP error, not a wrong order and not a leaked Python exception)
    when the id does not exist.
    """
    return ORDERS[order_id]


@mcp.tool()
def list_orders(cursor: str = None, page_size: int = 10) -> dict:
    """List orders in pages of page_size, continuing from cursor.

    STUB: always returns the same first page_size orders. It ignores
    cursor completely, so there is no way to reach anything past the
    first page, and it never tells the caller there might be more.
    It also has no floor or ceiling on page_size.

    Complete this so that:
      - the first call (no cursor) returns the first page, plus a
        cursor a caller can pass back to get the next one
      - passing that cursor back keeps walking forward through the
        whole dataset with no repeats and no skipped orders
      - once the dataset is exhausted, there's no cursor left to hand
        back
      - a page_size or cursor that doesn't make sense comes back as a
        real MCP error (isError: true, with a message that says what
        was wrong) -- never an empty page, a silently truncated one,
        or a raw exception
    """
    return {"items": ORDERS[:page_size]}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
