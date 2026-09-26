"""Reference solution -- never published to the learner, see docs/lab-authoring.md.

Proven live against ContextForge 1.0.10 / mcp 1.30.0 (see this lab's own
report): typed inputs surface as real JSON Schema, bad input comes back
isError:true with a clean message (both from an explicit ToolError and
implicitly from the SDK's own input-schema validation), and list_orders
paginates the full 55-row dataset in 6 pages with no duplicates or gaps.
"""
import os

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError

from dataset import ORDERS

PORT = int(os.environ.get("TOOL_SERVER_PORT", "8990"))
mcp = FastMCP("orders-tool-server", host="0.0.0.0", port=PORT)

_BY_ID = {o["id"]: o for o in ORDERS}
PAGE_SIZE_MIN = 1
PAGE_SIZE_MAX = 25


@mcp.tool()
def get_order(order_id: int) -> dict:
    """Look up a single order by its id. Fails cleanly if it does not exist."""
    order = _BY_ID.get(order_id)
    if order is None:
        raise ToolError(f"no order with id {order_id}")
    return dict(order)


@mcp.tool()
def list_orders(cursor: str | None = None, page_size: int = 10) -> dict:
    """List orders in pages.

    Pass no cursor to get the first page. Pass back the previous call's
    nextCursor to get the next page. nextCursor is omitted (null) once
    there is nothing left.
    """
    if not (PAGE_SIZE_MIN <= page_size <= PAGE_SIZE_MAX):
        raise ToolError(f"page_size must be between {PAGE_SIZE_MIN} and {PAGE_SIZE_MAX}")

    offset = 0
    if cursor is not None:
        try:
            offset = int(cursor)
        except ValueError:
            raise ToolError(f"invalid cursor: {cursor!r}")
        if offset < 0 or offset > len(ORDERS):
            raise ToolError(f"invalid cursor: {cursor!r}")

    page = ORDERS[offset : offset + page_size]
    next_offset = offset + len(page)
    next_cursor = str(next_offset) if next_offset < len(ORDERS) else None
    return {"items": page, "nextCursor": next_cursor, "total": len(ORDERS)}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
