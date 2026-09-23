# syntax=docker/dockerfile:1
# Gateway lab family: LiteLLM + Grafana + Prometheus + a load-generation tool.
#
# `next` is the floating preview tag matching package.json's
# @cloudflare/sandbox dependency ("next") — see images/agent/Dockerfile's
# comment for why this floats rather than pins, and the same 23 Sep 2026
# correction (a guessed "0.13.0-next" tag never existed).
FROM docker.io/cloudflare/sandbox:next

# musl: the Grafana .deb below depends on it — see images/agent/Dockerfile's
# comment for why it's installed here, before apt's lists are dropped,
# rather than relying on the Grafana RUN layer's own dependency fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates sudo python3 python3-pip musl \
    && rm -rf /var/lib/apt/lists/*

ARG GRAFANA_VERSION=11.4.0
RUN curl -fsSL "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb" -o /tmp/grafana.deb \
    && dpkg -i /tmp/grafana.deb \
    && rm -f /tmp/grafana.deb

ARG PROMETHEUS_VERSION=2.55.1
RUN curl -fsSL "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-amd64.tar.gz" -o /tmp/prom.tgz \
    && tar -xzf /tmp/prom.tgz -C /opt \
    && mv /opt/prometheus-${PROMETHEUS_VERSION}.linux-amd64 /opt/prometheus \
    && rm -f /tmp/prom.tgz

# --break-system-packages does not exist on this base image's pip3
# (22.0.2, from Ubuntu 22.04's python3-pip) -- that flag only exists on
# pip 23.0.1+ / newer Ubuntu releases that enforce PEP 668. Confirmed by a
# real CI build failure (23 Sep 2026, "no such option: --break-system-packages").
RUN pip3 install --no-cache-dir "litellm[proxy]" locust

RUN useradd -m -s /bin/bash learner \
    && mkdir -p /workspace /opt/lab \
    && chown learner:learner /workspace \
    && chown root:root /opt/lab && chmod 700 /opt/lab

COPY --chmod=755 opalix-init.sh /usr/local/bin/opalix-init.sh

WORKDIR /workspace
CMD ["/usr/local/bin/opalix-init.sh"]
