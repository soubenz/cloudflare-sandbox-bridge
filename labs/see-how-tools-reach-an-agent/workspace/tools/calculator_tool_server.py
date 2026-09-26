#!/usr/bin/env python3
"""A toy MCP tool server: three simple arithmetic tools.

`add`, `subtract` and `multiply`. Speaks the real MCP protocol over
streamable-http (the `mcp` PyPI package, a dependency of
mcp-contextforge-gateway itself), so ContextForge can federate it as a
gateway exactly like a real tool server.

    python3 -B calculator_tool_server.py

Reads its bind host/port from CALC_TOOL_HOST / CALC_TOOL_PORT.
"""

import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("CALC_TOOL_HOST", "127.0.0.1")
PORT = int(os.environ.get("CALC_TOOL_PORT", "7746"))

mcp = FastMCP("toy-calculator-server", host=HOST, port=PORT)


@mcp.tool()
def add(a: float, b: float) -> float:
    """Add two numbers and return the sum."""
    return a + b


@mcp.tool()
def subtract(a: float, b: float) -> float:
    """Subtract b from a and return the difference."""
    return a - b


@mcp.tool()
def multiply(a: float, b: float) -> float:
    """Multiply two numbers and return the product."""
    return a * b


if __name__ == "__main__":
    print("toy calculator tool server listening on %s:%d (tools: add, subtract, multiply)" % (HOST, PORT), flush=True)
    mcp.run(transport="streamable-http")
