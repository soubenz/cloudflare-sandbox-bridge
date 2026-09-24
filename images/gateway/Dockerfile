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
# Retried: the Ubuntu mirrors serve an index mid-sync often enough that a
# plain `apt-get update` fails the whole build with "File has unexpected
# size", and every deploy rebuilds these images.
RUN for attempt in 1 2 3; do \
      apt-get update -o Acquire::Retries=3 && break || { echo "apt-get update failed (attempt $attempt)"; sleep 10; }; \
    done \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    curl ca-certificates sudo python3 python3-pip musl tmux \
    && rm -rf /var/lib/apt/lists/*

# The learner's shell runs inside tmux so it survives the PTY connection
# dropping (a closed browser tab, a Durable Object eviction): the container's
# PTY server kills its shell when the websocket goes away, but tmux keeps
# the session, its cwd, its environment and any running process.
# Presented as a plain terminal — no status bar, and a deep scrollback.
RUN printf 'set -g status off\nset -g history-limit 10000\nset -g mouse on\n' > /etc/opalix-tmux.conf


ARG GRAFANA_VERSION=11.4.0
RUN curl -fsSL "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb" -o /tmp/grafana.deb \
    && dpkg -i /tmp/grafana.deb \
    && rm -f /tmp/grafana.deb

# Grafana listens on :3000 out of the box, and :3000 is the one port
# @cloudflare/sandbox reserves for its own control plane (`validatePort`:
# 1024-65535, excluding 3000; mirrored in src/labs/manifest.ts as
# SANDBOX_CONTROL_PLANE_PORT). Left at the default, grafana-server exits at
# boot with "bind: address already in use" and the lab author has no way to
# guess why -- so this image defaults Grafana to :3001 instead.
#
# Set in /etc/grafana/grafana.ini rather than as `ENV GF_SERVER_HTTP_PORT`
# on purpose: the config file is the lower-precedence layer (defaults.ini <
# grafana.ini < GF_* env < argv), and a lab manifest's service env is the
# layer labs speak in. A manifest that sets GF_SERVER_HTTP_PORT therefore
# still wins over this default, instead of tying with an image-level ENV of
# the same name whose merge order is the runtime's business.
#
# preinstall_disabled: Grafana 11.4 installs grafana-lokiexplore-app from
# grafana.com on every boot. These containers have no route to grafana.com
# by design (the egress fence), so it only ever logs "API returned invalid
# status: 520 Server Error" and costs startup time on a boot that already
# dominates the family's cold start. Repeated as an ENV below so it holds
# even for a lab that runs grafana-server against its own --config: unlike
# the port, no lab has a reason to want the preinstall back.
#
# 11.4's packaged grafana.ini ships http_port commented out and carries no
# preinstall_disabled line at all (that key lives in conf/defaults.ini only),
# hence one substitution and one append. The greps make a future Grafana
# that reshapes this file fail the build loudly, rather than silently
# shipping the broken default again.
RUN sed -i -E \
      -e 's/^;?[[:space:]]*http_port[[:space:]]*=.*/http_port = 3001/' \
      -e '/^\[plugins\]/a preinstall_disabled = true' \
          -e '/^\[security\]/a allow_embedding = true' \
      /etc/grafana/grafana.ini \
    && grep -qx 'http_port = 3001' /etc/grafana/grafana.ini \
    && grep -qx 'preinstall_disabled = true' /etc/grafana/grafana.ini \
      && grep -qx 'allow_embedding = true' /etc/grafana/grafana.ini
ENV GF_PLUGINS_PREINSTALL_DISABLED=true

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
