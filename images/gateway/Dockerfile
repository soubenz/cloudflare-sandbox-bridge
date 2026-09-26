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
# postgresql: LiteLLM's DB layer (virtual keys, teams, spend tracking)
# hard-requires PostgreSQL -- SQLite is refused outright at startup
# ("DATABASE_URL uses unsupported scheme 'sqlite'", confirmed live in
# docs/spike.md's LiteLLM proxy spike, T4, 26 Sep 2026). Ubuntu 22.04's
# `postgresql` meta-package pulls in a real `initdb`/server; the assertion
# below fails the build loudly if a future base image renames or drops it
# rather than shipping a gateway that silently can't start a cluster.
# DEBIAN_FRONTEND=noninteractive on this one command only: postgresql pulls
# in tzdata, which otherwise stops the build waiting for a timezone answer.
# Scoped to the RUN, not an ENV, so it doesn't leak into lab containers.
RUN for attempt in 1 2 3; do \
      apt-get update -o Acquire::Retries=3 && break || { echo "apt-get update failed (attempt $attempt)"; sleep 10; }; \
    done \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    curl ca-certificates sudo python3 python3-pip musl tmux postgresql \
    && rm -rf /var/lib/apt/lists/* \
    && test -x "$(ls /usr/lib/postgresql/*/bin/initdb | head -1)"

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
#
# Pinned to 1.102.1: the exact version "litellm[proxy]" resolves to today
# and the one proven live in docs/spike.md. `litellm[proxy]` does NOT
# install the `prisma` Python package (confirmed live: right after this
# install, `pip3 show prisma` finds nothing, and starting the proxy against
# Postgres crashes with `ModuleNotFoundError: No module named 'prisma'`),
# so prisma==0.15.0 -- the version the build-time `prisma generate` step
# below matches -- is installed alongside it explicitly.
RUN pip3 install --no-cache-dir "litellm[proxy]==1.102.1" "prisma==0.15.0" locust \
    && pip3 show litellm | grep -qx 'Version: 1.102.1'

# MLflow, for Path 2's model-catalogue lab: its model registry's aliases
# drive which provider model a LiteLLM alias points to. Pinned to 3.16.1,
# the version the feasibility run proved alongside litellm 1.102.1 and
# prisma 0.15.0 (`pip check` clean in one environment). The full package,
# not mlflow-skinny: skinny can't run `mlflow server` without a hand-picked
# set of extra deps and never ships the UI at all.
#
# litellm and prisma are named again at their pins so pip resolves MLflow
# around them instead of upgrading a dependency they were proven with.
RUN pip3 install --no-cache-dir "mlflow==3.16.1" "litellm[proxy]==1.102.1" "prisma==0.15.0" \
    && pip3 show mlflow | grep -qx 'Version: 3.16.1' \
    && pip3 show litellm | grep -qx 'Version: 1.102.1' \
    && pip3 show prisma | grep -qx 'Version: 0.15.0' \
    && python3 -c "import mlflow.server, litellm"
# MLflow 3.16's defaults, each wrong for a lab container:
# - telemetry is on and calls config.mlflow-telemetry.io, which the egress
#   fence refuses anyway -- off, so it isn't even attempted;
# - `mlflow server` starts a job runner plus several worker processes for
#   GenAI scorers on every boot, used or not: ~1.8 GB RSS against ~650 MB
#   without it, on a 4 GiB container that also runs LiteLLM and Postgres;
# - a startup banner advertising an agent integration.
ENV MLFLOW_DISABLE_TELEMETRY=1
ENV MLFLOW_SERVER_ENABLE_JOB_EXECUTION=false
ENV MLFLOW_DISABLE_AGENT_HINT=1

# `prisma generate` must run at build time, against the schema shipped
# inside litellm_proxy_extras, because it's the one step in this whole
# install that reaches the network: it downloads a Node-based Prisma CLI
# plus 5 query-engine binaries and writes the generated client into
# site-packages (confirmed live in docs/spike.md: without this, the proxy
# fails with "Unable to find Prisma binaries. Please run 'prisma generate'
# first."). These lab containers have no internet at runtime (the egress
# fence), so this cannot be deferred to first boot -- unlike the DB
# migrations, which the proxy runs itself on every boot via
# `prisma migrate deploy` against its own bundled migrations, needing only
# Postgres, not the network.
#
# DATABASE_URL only needs to be a syntactically valid postgresql:// URL
# here -- the schema's `datasource` block just reads the env var, it
# doesn't have to connect. Verified locally: `prisma generate` against
# postgresql://x:x@127.0.0.1:1/x, with nothing listening on that port,
# still succeeds.
#
# The downloaded CLI and query-engine binaries are cached under the build
# user's (root's) home (~/.cache/prisma, ~/.cache/prisma-python) rather
# than anywhere baked into the image explicitly -- that's fine because
# every lab service in this image runs as root, not as `learner`.
RUN DATABASE_URL="postgresql://opalix:opalix@127.0.0.1:5432/opalix" \
    prisma generate --schema="$(python3 -c "import litellm_proxy_extras, os; print(os.path.join(os.path.dirname(litellm_proxy_extras.__file__), 'schema.prisma'))")" \
    && python3 -c "import prisma" \
    && python3 -c "import prisma.models as m; assert hasattr(m, 'LiteLLM_BudgetTable'), 'prisma client was not generated against the litellm schema'"

# A Postgres data dir with LiteLLM's schema already migrated, copied into
# place by each lab's postgres service instead of running initdb. Halves
# LiteLLM's boot (33 s to 16-18 s on one core locally), since a session
# no longer runs 171 migrations and the check that follows them. See the
# script for the two databases it leaves and why.
COPY --chmod=755 build-pg-template.sh /usr/local/bin/build-pg-template.sh
RUN /usr/local/bin/build-pg-template.sh /opt/opalix/pg-template

# Stops LiteLLM re-fetching model_prices_and_context_window.json from
# GitHub on every cold boot: with no internet at runtime, that fetch just
# burns ~6-7s of retries with backoff before falling back to litellm's
# bundled copy anyway (confirmed live in docs/spike.md; both runs reach
# the same fallback data, this one just skips the wait).
ENV LITELLM_LOCAL_MODEL_COST_MAP=True

# Python's httpx/requests (unlike curl and urllib) verify against
# certifi's bundled CA list, not the system store, so they ignore the CA
# that opalix-init.sh adds to the system store at boot
# (update-ca-certificates). Confirmed live: httpx failed
# CERTIFICATE_VERIFY_FAILED against the allowed AI Gateway host while
# curl and urllib reached it fine; pointing httpx/requests at the system
# bundle here fixed it. This only takes effect once opalix-init.sh has
# actually installed the CA at boot -- the file doesn't exist yet at
# build time.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN useradd -m -s /bin/bash learner \
    && mkdir -p /workspace /opt/lab \
    && chown learner:learner /workspace \
    && chown root:root /opt/lab && chmod 700 /opt/lab

COPY --chmod=755 opalix-init.sh /usr/local/bin/opalix-init.sh

WORKDIR /workspace
CMD ["/usr/local/bin/opalix-init.sh"]
