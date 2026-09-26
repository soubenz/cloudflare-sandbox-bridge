#!/usr/bin/env python3
"""The inventory team's own MCP tool server.

One tool, `lookup_stock`, backed by a small in-memory table. This team
built and deployed this server on its own, before there was any platform
gateway -- it listens on its own port and nobody outside the team has ever
had a governed way to reach it.

Env:
  INVENTORY_HOST  default 127.0.0.1
  INVENTORY_PORT  required
"""
import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("INVENTORY_HOST", "127.0.0.1")
PORT = int(os.environ["INVENTORY_PORT"])

mcp = FastMCP("inventory", host=HOST, port=PORT)

_STOCK = {
    "widget-a": 42,
    "widget-b": 0,
    "gadget-c": 17,
}


@mcp.tool()
def lookup_stock(sku: str) -> dict:
    """Look up how many units of a SKU are currently in stock."""
    sku = sku.strip().lower()
    if sku not in _STOCK:
        return {"sku": sku, "found": False}
    return {"sku": sku, "found": True, "quantity": _STOCK[sku]}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
