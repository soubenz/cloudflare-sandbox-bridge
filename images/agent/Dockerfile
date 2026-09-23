# syntax=docker/dockerfile:1
# Agent lab family: Python agent runtime + LiteLLM + Grafana.
#
# `next-python` is the floating preview tag, matching package.json's
# @cloudflare/sandbox dependency (also "next", not a pinned version) — the
# two float together so they can't drift apart silently. Confirmed to exist
# on Docker Hub (docker.io/cloudflare/sandbox tags) on 23 Sep 2026; an
# earlier guess at a pinned "0.13.0-next-python" tag was wrong (never
# published — real pinned preview tags look like "0.13.0-next.776.1-python").
# Before GA, switch both this and package.json's dependency to matching
# exact pinned versions for a reproducible build.
FROM docker.io/cloudflare/sandbox:next-python

# --- System packages ---
# musl: the Grafana .deb below depends on it; installing it here (while apt
# lists are still present) means the later `dpkg -i` for Grafana already
# has it satisfied. A real CI build (23 Sep 2026) showed that without this,
# `dpkg -i`'s `apt-get install -f -y` fallback removes Grafana instead of
# fetching musl, once apt's lists had already been dropped in this layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates sudo musl \
    && rm -rf /var/lib/apt/lists/*

# --- Grafana (OSS) ---
ARG GRAFANA_VERSION=11.4.0
RUN curl -fsSL "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb" -o /tmp/grafana.deb \
    && dpkg -i /tmp/grafana.deb \
    && rm -f /tmp/grafana.deb

# --- LiteLLM proxy ---
# `python3 -m pip`, not bare `pip`: the base image's Python (the SDK's
# python-build-standalone interpreter) does not put a `pip` binary on PATH,
# confirmed by a real CI build failure (23 Sep 2026, "pip: not found").
RUN python3 -m pip install --no-cache-dir "litellm[proxy]"

# --- Unprivileged learner user; the terminal and workspace files run as this user ---
RUN useradd -m -s /bin/bash learner \
    && mkdir -p /workspace /opt/lab \
    && chown learner:learner /workspace \
    && chown root:root /opt/lab && chmod 700 /opt/lab

COPY --chmod=755 opalix-init.sh /usr/local/bin/opalix-init.sh

WORKDIR /workspace

# Never override ENTRYPOINT: the sandbox binary starts its own control
# server first, then spawns this CMD as a child with signal forwarding.
CMD ["/usr/local/bin/opalix-init.sh"]
