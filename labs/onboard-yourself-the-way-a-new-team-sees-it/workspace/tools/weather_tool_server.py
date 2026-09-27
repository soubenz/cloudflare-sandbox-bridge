#!/usr/bin/env python3
"""A toy MCP tool server: a scripted stand-in for a weather API.

Two tools, `get_weather` and `get_forecast`, both returning deterministic,
made-up data derived from the city name -- there is no real weather API
here and no route out of the container to one. Speaks the real MCP
protocol over streamable-http (the `mcp` PyPI package, a dependency of
mcp-contextforge-gateway itself -- not an invented contract), so
ContextForge can federate it as a gateway exactly like a real tool server.

    python3 -B weather_tool_server.py

Reads its bind host/port from WEATHER_TOOL_HOST / WEATHER_TOOL_PORT.
"""

import os

from mcp.server.fastmcp import FastMCP

HOST = os.environ.get("WEATHER_TOOL_HOST", "127.0.0.1")
PORT = int(os.environ.get("WEATHER_TOOL_PORT", "7745"))

mcp = FastMCP("toy-weather-server", host=HOST, port=PORT)

# Deterministic per-city numbers, just so the same city always answers the
# same way -- not meant to resemble a real forecast.
_CONDITIONS = ["sunny", "cloudy", "rainy", "windy"]


def _seed(city: str) -> int:
    return sum(ord(c) for c in city.lower())


@mcp.tool()
def get_weather(city: str) -> dict:
    """Get the current made-up weather for a city."""
    seed = _seed(city)
    return {
        "city": city,
        "temperature_c": 10 + (seed % 25),
        "conditions": _CONDITIONS[seed % len(_CONDITIONS)],
    }


@mcp.tool()
def get_forecast(city: str, days: int = 3) -> dict:
    """Get a made-up multi-day forecast for a city."""
    seed = _seed(city)
    days = max(1, min(int(days), 7))
    return {
        "city": city,
        "days": [
            {
                "day": i + 1,
                "temperature_c": 10 + ((seed + i * 3) % 25),
                "conditions": _CONDITIONS[(seed + i) % len(_CONDITIONS)],
            }
            for i in range(days)
        ],
    }


if __name__ == "__main__":
    print("toy weather tool server listening on %s:%d (tools: get_weather, get_forecast)" % (HOST, PORT), flush=True)
    mcp.run(transport="streamable-http")
