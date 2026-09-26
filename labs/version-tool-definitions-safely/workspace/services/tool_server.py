"""The tool server behind this lab: one tool, two versions.

Run as ``python3 tool_server.py v1`` or ``python3 tool_server.py v2``. Each
mode starts a single FastMCP app, on its own fixed port, speaking the real
MCP streamable-http transport -- this is what ContextForge federates as a
gateway. Both versions are already running as two separate services
(see manifest.yaml); this file is the one place their behavior is defined,
and you can edit + restart either service independently from the Services
panel.

v1.lookup_price(sku) -> a bare number, e.g. 19.99
v2.lookup_price(sku) -> {"amount": <number>, "currency": "USD"}

v2 is a breaking change in OUTPUT SHAPE only (the input, "sku", is
unchanged) -- a caller written against v1, that expects a bare number back,
will fail or corrupt its own math against v2 without any request-side
change at all. That is the whole point: the danger here is entirely in
*when* callers get routed to which version, not in how to write v2's code
(that part is already done for you).
"""
import sys
from typing import TypedDict

from mcp.server.fastmcp import FastMCP

PRICES = {
    "sku-1": 19.99,
    "sku-2": 4.50,
    "sku-3": 120.00,
}


class PriceV2(TypedDict):
    amount: float
    currency: str


def build_v1() -> FastMCP:
    app = FastMCP("price-tool-v1", host="0.0.0.0", port=65101)

    @app.tool()
    def lookup_price(sku: str) -> float:
        """Look up the price of a SKU. Returns a bare number (v1 contract)."""
        if sku not in PRICES:
            raise ValueError("unknown sku: %s" % sku)
        return PRICES[sku]

    return app


def build_v2() -> FastMCP:
    app = FastMCP("price-tool-v2", host="0.0.0.0", port=65102)

    @app.tool()
    def lookup_price(sku: str) -> PriceV2:
        """Look up the price of a SKU. Returns {"amount", "currency"} (v2 contract)."""
        if sku not in PRICES:
            raise ValueError("unknown sku: %s" % sku)
        return {"amount": PRICES[sku], "currency": "USD"}

    return app


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("v1", "v2"):
        print("usage: tool_server.py {v1|v2}", file=sys.stderr)
        raise SystemExit(2)
    app = build_v1() if sys.argv[1] == "v1" else build_v2()
    app.run(transport="streamable-http")


if __name__ == "__main__":
    main()
