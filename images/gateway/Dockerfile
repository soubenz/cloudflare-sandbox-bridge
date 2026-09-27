# syntax=docker/dockerfile:1
# Gateway lab family: LiteLLM + Grafana + Prometheus + a load-generation tool
# + pgvector + Qdrant + Arize Phoenix (Path 2 Module 3) + Jaeger + the OTel
# Collector (Path 2 Module 4).
#
# Qdrant ships as a binary inside its own official image, not an apt
# package or a plain GitHub release this Dockerfile can just curl (unlike
# Jaeger/otelcol-contrib below) — pulled here as a separate build stage and
# copied out, proven against real Qdrant 1.19.1 in the Module 3 feasibility
# investigation (scratchpad retrieval-inv/FINDINGS.md).
FROM qdrant/qdrant:v1.19.1 AS qdrant-src

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
#
# gnupg: needed below to add the PGDG apt repo's signing key (pgvector).
# libunwind8/liblzma5: Qdrant's binary is dynamically linked against both
# (confirmed via `ldd`, Module 3 feasibility investigation) and neither is
# pulled in by anything else installed here -- liblzma5 is normally already
# present on jammy, but named explicitly rather than relied on.
# python3-venv: Ubuntu splits venv support out of the base `python3`
# package (`python3 -m venv` fails with "ensurepip is not available"
# otherwise) -- the same reason images/agent/Dockerfile installs
# `python3.12-venv` alongside `python3.12` for ContextForge. Needed here
# for Arize Phoenix's own isolated venv, further below.
RUN for attempt in 1 2 3; do \
      apt-get update -o Acquire::Retries=3 && break || { echo "apt-get update failed (attempt $attempt)"; sleep 10; }; \
    done \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    curl ca-certificates sudo python3 python3-pip python3-venv musl tmux postgresql gnupg libunwind8 liblzma5 \
    && rm -rf /var/lib/apt/lists/* \
    && test -x "$(ls /usr/lib/postgresql/*/bin/initdb | head -1)"

# pgvector, for Path 2 Module 3's retrieval labs. Ubuntu 22.04 (jammy)'s own
# universe has NO pgvector package at any suite (jammy/jammy-updates/jammy-
# backports) -- confirmed against packages.ubuntu.com's own index; pgvector
# only entered Ubuntu's own archive at noble (24.04). The PGDG apt repo is
# the only real path for a package matching this image's PG14, and it has
# one: postgresql-14-pgvector 0.8.6-1.pgdg22.04+2 (confirmed against PGDG's
# own published jammy-pgdg package index). CREATE EXTENSION vector, both
# distance operators, and both IVFFlat and HNSW indexes were all proven
# live against a real PG14 in the Module 3 feasibility investigation
# (scratchpad retrieval-inv/FINDINGS.md); build-pg-template.sh below
# re-proves CREATE EXTENSION at image build time against this image's own
# Postgres, not just the investigation's.
RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 postgresql-14-pgvector \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l postgresql-14-pgvector | grep -q '^ii'

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

# Qdrant, for Path 2 Module 3's retrieval labs. Copied from the qdrant-src
# stage declared at the top of this file (its own binary is dynamically
# linked, needs libunwind8/liblzma5, both installed above) rather than an
# apt package (none exists) or a hand-guessed release-tarball URL. The
# dashboard's static assets come along too, since Qdrant's dashboard is
# `ui: true` directly in every lab that uses it -- confirmed live with no
# `api_key` configured, no login screen ever renders (Module 3 feasibility
# investigation, scratchpad retrieval-inv/FINDINGS.md). The version
# assertion fails the build loudly if the pinned image tag ever stops
# resolving to a real binary at this path.
COPY --from=qdrant-src /qdrant/qdrant /usr/local/bin/qdrant
COPY --from=qdrant-src /qdrant/static /opt/opalix/qdrant-static
RUN chmod +x /usr/local/bin/qdrant \
    && /usr/local/bin/qdrant --version
# Qdrant resolves its dashboard's static assets relative to its own
# working directory by default (its packaged image runs with CWD at
# /qdrant, alongside /qdrant/static) -- but a lab's own manifest sets its
# qdrant service's `cwd` to /workspace, not wherever this Dockerfile put
# the binary. Rather than depend on every Qdrant-using lab's own
# config.yaml remembering to override this, set it once here as an env
# default: Qdrant's own `QDRANT__<SECTION>__<KEY>` env-var convention
# (the same mechanism proven for QDRANT__TELEMETRY_DISABLED in the Module
# 3 feasibility investigation) overrides its YAML config regardless of
# what a lab's own config.yaml does or doesn't set.
ENV QDRANT__SERVICE__STATIC_CONTENT_DIR=/opt/opalix/qdrant-static

# Jaeger, for Path 2 Module 4's tracing labs. Recommended over Grafana
# Tempo with real evidence, not a guess: Jaeger alone does everything a
# learner needs (~60 MB idle, its own UI, no login by default, confirmed
# live), where Tempo ships no UI of its own and would need Grafana on top
# for anything a learner actually looks at. Jaeger v2's all-in-one is
# itself built on the OTel Collector framework and needs a real YAML
# config (no more simple env-var flags) -- each lab's own manifest
# supplies that config as a workspace file. Full findings: scratchpad
# otel-inv/FINDINGS.md.
ARG JAEGER_VERSION=2.21.0
RUN curl -fsSL "https://github.com/jaegertracing/jaeger/releases/download/v${JAEGER_VERSION}/jaeger-${JAEGER_VERSION}-linux-amd64.tar.gz" -o /tmp/jaeger.tgz \
    && tar -xzf /tmp/jaeger.tgz -C /opt \
    && mv "/opt/jaeger-${JAEGER_VERSION}-linux-amd64" /opt/jaeger \
    && ln -s /opt/jaeger/jaeger /usr/local/bin/jaeger \
    && rm -f /tmp/jaeger.tgz \
    && test -x /usr/local/bin/jaeger
# Two Module 4 labs invoke this binary bare ("jaeger", relying on the
# /usr/local/bin symlink above); a live verification run found a third
# (labs/follow-one-request-through-the-stack) hardcodes
# /opt/opalix/bin/jaeger instead -- the path its own build agent happened
# to install to locally. Rather than pick one true path and break
# whichever labs assumed the other, both are satisfied: the same binary,
# reachable both ways.
RUN mkdir -p /opt/opalix/bin && ln -s /usr/local/bin/jaeger /opt/opalix/bin/jaeger

# The OTel Collector, contrib distribution -- confirmed mandatory, not a
# preference: `tail_sampling` (the only error-aware sampling processor,
# the exact primitive Module 4's "keep every error trace" lab needs) only
# exists in contrib, confirmed by direct component enumeration against
# both distributions. Real ~390 MiB, not a mistake -- it bundles far more
# receivers/processors/exporters than any one lab uses; a custom trimmed
# OCB build was considered and not attempted (scratchpad otel-inv/FINDINGS.md).
ARG OTELCOL_VERSION=0.161.0
RUN curl -fsSL "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_amd64.tar.gz" -o /tmp/otelcol.tgz \
    && mkdir -p /opt/otelcol-contrib \
    && tar -xzf /tmp/otelcol.tgz -C /opt/otelcol-contrib \
    && ln -s /opt/otelcol-contrib/otelcol-contrib /usr/local/bin/otelcol-contrib \
    && rm -f /tmp/otelcol.tgz \
    && test -x /usr/local/bin/otelcol-contrib \
    && /usr/local/bin/otelcol-contrib components | grep -q tail_sampling

# ContextForge (mcp-contextforge-gateway), for Path 2 Module 6's onboarding
# lab (labs/onboard-yourself-the-way-a-new-team-sees-it), which is
# family: gateway but needs the tool-gateway ContextForge already proven
# for Module 2's agent-family labs. Same exact setup as
# images/agent/Dockerfile (pinned 1.0.10, Python 3.12 from deadsnakes in
# its own venv since no version with the multi-tenancy features these
# labs need supports this image's own default Python either) -- see that
# file's own comments for the full reasoning, not repeated here.
#
# The python3.12 shadowing below overwrites /usr/bin/python3.12 directly,
# not just /usr/local/bin -- a real CI build failure on the agent image
# (27 Sep 2026) proved this base's PATH resolves /usr/bin ahead of
# /usr/local/bin, the opposite of what a /usr/local/bin-only symlink
# assumes, so that alone still resolved bare `python3.12` to the system
# deadsnakes interpreter and raised ModuleNotFoundError. Needed because a
# lab invoking `python3.12 -m mcpgateway` directly -- exactly what this
# lab does -- would otherwise fail the same way.
RUN apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    python3.12 python3.12-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3.12 -m venv /opt/contextforge-venv \
    && /opt/contextforge-venv/bin/pip install --no-cache-dir "mcp-contextforge-gateway==1.0.10" \
    && /opt/contextforge-venv/bin/pip show mcp-contextforge-gateway | grep -qx 'Version: 1.0.10' \
    && ln -s /opt/contextforge-venv/bin/mcpgateway /usr/local/bin/mcpgateway \
    && ln -s /opt/contextforge-venv/bin/mcpgateway-server /usr/local/bin/mcpgateway-server \
    && rm -f /usr/bin/python3.12 \
    && ln -s /opt/contextforge-venv/bin/python3.12 /usr/local/bin/python3.12 \
    && ln -s /opt/contextforge-venv/bin/python3.12 /usr/bin/python3.12 \
    && test -x /usr/local/bin/mcpgateway && test -x /usr/local/bin/mcpgateway-server \
    && python3.12 -c "import mcpgateway; print(mcpgateway.__version__)"

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

# fastapi/uvicorn/psycopg2-binary, for Path 2 Module 3's pgvector labs: a
# live verification run caught two labs' own learner-facing services
# (labs/offer-a-retrieval-service-teams-dont-build's `platform`,
# labs/add-hybrid-search-and-reranking's `search`) invoking plain
# `python3`/`python3 -m uvicorn` directly, not an isolated venv -- neither
# was installed anywhere in this image. psycopg2-binary bundles its own
# libpq, so it needs nothing beyond the `postgresql` package already
# installed above.
RUN pip3 install --no-cache-dir fastapi "uvicorn[standard]" psycopg2-binary \
    && python3 -c "import fastapi, uvicorn, psycopg2"

# flask/requests + the OTel SDK and its Flask/requests auto-instrumentation,
# for Path 2 Module 4's tracing labs: a live verification run found three
# of that module's own services (labs/follow-one-request-through-the-stack's
# seed_trace.py, labs/see-one-request-across-every-service's gateway/worker/
# storage) invoke plain python3 directly against these packages, none of
# which existed anywhere in this image -- same shared-environment
# convention as fastapi/psycopg2 above, not an isolated venv.
RUN pip3 install --no-cache-dir flask requests opentelemetry-sdk \
    opentelemetry-exporter-otlp-proto-http opentelemetry-instrumentation-flask \
    opentelemetry-instrumentation-requests \
    && python3 -c "import flask, requests, opentelemetry.sdk.trace, opentelemetry.instrumentation.flask, opentelemetry.instrumentation.requests"

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

# Arize Phoenix, for Path 2 Module 3's retrieval-quality labs. Its own
# isolated venv, not this image's shared pip environment -- a real,
# reproduced incompatibility forces this, the same shape as ContextForge
# needing its own Python 3.12 in images/agent/Dockerfile:
# `litellm[proxy]==1.102.1`'s `proxy` extra declares `mcp>=1.28.1,<2.0`,
# while arize-phoenix needs `mcp>=2.x` (imports `AuthorizationCodeResult`
# from `mcp.shared.auth`, only present in mcp 2.x); sharing an environment
# silently downgrades mcp to satisfy litellm and Phoenix then hard-crashes
# at import with an ImportError -- reproduced live (scratchpad
# retrieval-inv/FINDINGS.md). Uses this image's own default python3
# (Ubuntu 22.04's 3.10) -- unlike ContextForge, Phoenix needs no second
# interpreter, only isolation from litellm's own mcp pin.
#
# Four env vars, each confirmed live and none optional (same posture as
# the MLflow flags above): PHOENIX_ENABLE_AUTH is left unset on purpose --
# it defaults off, and setting it to anything is what turns a login screen
# on. PHOENIX_TELEMETRY_ENABLED=false drops a Scarf.sh/FullStory pixel
# from served pages (a privacy default, not an offline-capability fix --
# it's the learner's browser that would fetch it, not the container).
# PHOENIX_DISABLE_AGENT_ASSISTANT=true stops a hosted-MCP outbound call an
# "agent assistant" makes by default on every boot. PHOENIX_WASM_BINARY_PATH
# stops a separate `github.com` fetch attempt (a WASM sandbox runtime) at
# every boot -- confirmed NOT gated by the more obvious
# PHOENIX_ALLOWED_SANDBOX_PROVIDERS=NONE (a real gap in Phoenix's own env
# coverage); Phoenix uses the path as-is with no verification when it's
# explicitly set, so a placeholder file is enough, matching the
# investigation's own proof.
# Paths -- /opt/opalix/venvs/phoenix and /opt/opalix/assets/phoenix-wasm/
# -- match what the Module 3 lab-building agents independently converged
# on and already shipped inside labs/see-why-a-document-matched/manifest.yaml
# (`argv: ["/opt/opalix/venvs/phoenix/bin/python", ...]`), rather than the
# other way around: a live verification run caught this image using
# /opt/phoenix-venv instead and failing with a plain ENOENT at session
# start, exactly the kind of image/lab integration mismatch live testing
# exists to catch. Conforming the image to the already-tested lab, not
# editing the lab to match a path nothing else depends on.
RUN python3 -m venv /opt/opalix/venvs/phoenix \
    && /opt/opalix/venvs/phoenix/bin/pip install --no-cache-dir "arize-phoenix==20.16.0" \
    && /opt/opalix/venvs/phoenix/bin/pip show arize-phoenix | grep -qx 'Version: 20.16.0' \
    && ln -s /opt/opalix/venvs/phoenix/bin/phoenix /usr/local/bin/phoenix \
    && test -x /usr/local/bin/phoenix \
    && mkdir -p /opt/opalix/assets/phoenix-wasm \
    && : > /opt/opalix/assets/phoenix-wasm/pyodide.wasm
ENV PHOENIX_TELEMETRY_ENABLED=false
ENV PHOENIX_DISABLE_AGENT_ASSISTANT=true
ENV PHOENIX_WASM_BINARY_PATH=/opt/opalix/assets/phoenix-wasm/pyodide.wasm

# labs/see-why-a-document-matched's own `app` service assumes its own
# isolated venv at this exact path (defensive, per its own manifest
# comment, against an unconfirmed conflict with the shared environment
# above -- never actually tested against this real image at build time).
# Same conform-the-image-to-the-tested-lab reasoning as Phoenix's path
# fix above.
RUN python3 -m venv /opt/opalix/venvs/see-why-a-document-matched \
    && /opt/opalix/venvs/see-why-a-document-matched/bin/pip install --no-cache-dir \
    fastapi "uvicorn[standard]" psycopg2-binary opentelemetry-sdk \
    opentelemetry-exporter-otlp-proto-http openinference-semantic-conventions \
    && /opt/opalix/venvs/see-why-a-document-matched/bin/python -c "import fastapi, uvicorn, psycopg2, opentelemetry.sdk.trace, openinference.semconv.trace"

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
