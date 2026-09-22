# syntax=docker/dockerfile:1
# Agent lab family: Python agent runtime + LiteLLM + Grafana.
# Base image tag must match the @cloudflare/sandbox npm version installed
# (this repo pins "next" -> keep this in sync with `npm ls @cloudflare/sandbox`;
# the exact matching tag is confirmed in the Phase 0 spike, see docs/spike.md).
FROM docker.io/cloudflare/sandbox:0.13.0-next-python

# --- System packages ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates sudo \
    && rm -rf /var/lib/apt/lists/*

# --- Grafana (OSS) ---
ARG GRAFANA_VERSION=11.4.0
RUN curl -fsSL "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb" -o /tmp/grafana.deb \
    && (dpkg -i /tmp/grafana.deb || apt-get install -f -y) \
    && rm -f /tmp/grafana.deb

# --- LiteLLM proxy ---
RUN pip install --no-cache-dir "litellm[proxy]"

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
