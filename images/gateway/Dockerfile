# syntax=docker/dockerfile:1
# Gateway lab family: LiteLLM + Grafana + Prometheus + a load-generation tool
# + pgvector + Qdrant + Arize Phoenix (Path 2 Module 3) + Jaeger + the OTel
# Collector (Path 2 Module 4).
#
# Qdrant ships as a binary inside its own official image, not an apt
# package or a plain GitHub release this Dockerfile can just curl (unlike
# Jaeger/otelcol-contrib below) — pulled here as a separate build stage and
# copied out, proven against real Qdrant 1.19.1 in the Module 3 feasibility
# investigation (scratchpad retrieval-inv/FINDINGS.md). Pinned by digest too
# (the multi-arch index digest of v1.19.1 on Docker Hub, 30 Sep 2026): a tag
# can be re-pushed, a digest cannot.
#
# Everything in this image is pinned to what the deployed image was actually
# running (captured live 30 Sep 2026): the base tag, the apt versions that
# matter, the sha256 of every downloaded binary, and every Python package via
# the requirements-*.txt files next to this Dockerfile (full `pip freeze`
# output, transitive dependencies included). To move any of it forward,
# change it here on purpose; nothing floats on a rebuild any more.
FROM qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10 AS qdrant-src

# 0.13.0-next.776.1 is what the floating `next` tag pointed at when the
# deployed image was built (SANDBOX_VERSION=0.13.0-next.776.1 is baked into it;
# same digest as `next` on Docker Hub, 30 Sep 2026). package.json's
# @cloudflare/sandbox dependency is still the `next` tag, which
# package-lock.json resolved to 0.13.0-next.769.1 -- the tag drifted between
# the two; pin package.json to 0.13.0-next.776.1 too so the SDK and the
# container agree. See images/agent/Dockerfile's comment for the 23 Sep 2026
# correction (a guessed "0.13.0-next" tag never existed).
FROM docker.io/cloudflare/sandbox:0.13.0-next.776.1

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
# own published jammy-pgdg package index). Installed at the exact PGDG
# builds that were running: postgresql-14=14.24-1.pgdg22.04+2 (pgvector's
# dependency pulls the server up from Ubuntu's build to this one, so it is
# named here rather than left to that side effect) and
# postgresql-14-pgvector=0.8.6-1.pgdg22.04+2. PGDG keeps only recent builds
# in its index, so a future rebuild that can no longer find one of these
# fails loudly at the apt-get install: bump it on purpose then.
#
# The signing key is checked by fingerprint (B97B 0AFC AA1A 47F0 44F2 44A0
# 7FCC 7D46 ACCC 4CF8, the PostgreSQL Debian Repository key), on the armored
# download and again on the dearmored keyring, before it is trusted.
# `--with-colons` because gpg's human-readable output spaces the fingerprint
# out in groups of four. CREATE EXTENSION vector, both
# distance operators, and both IVFFlat and HNSW indexes were all proven
# live against a real PG14 in the Module 3 feasibility investigation
# (scratchpad retrieval-inv/FINDINGS.md); build-pg-template.sh below
# re-proves CREATE EXTENSION at image build time against this image's own
# Postgres, not just the investigation's.
RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /tmp/pgdg.asc \
    && gpg --show-keys --with-colons --fingerprint /tmp/pgdg.asc | grep -q '^fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:$' \
    && gpg --dearmor -o /usr/share/keyrings/pgdg.gpg /tmp/pgdg.asc \
    && gpg --show-keys --with-colons --fingerprint /usr/share/keyrings/pgdg.gpg | grep -q '^fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:$' \
    && rm -f /tmp/pgdg.asc \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
       postgresql-14=14.24-1.pgdg22.04+2 postgresql-14-pgvector=0.8.6-1.pgdg22.04+2 \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l postgresql-14-pgvector | grep -q '^ii'

# The learner's shell runs inside tmux so it survives the PTY connection
# dropping (a closed browser tab, a Durable Object eviction): the container's
# PTY server kills its shell when the websocket goes away, but tmux keeps
# the session, its cwd, its environment and any running process.
# Presented as a plain terminal — no status bar, and a deep scrollback.
RUN printf 'set -g status off\nset -g history-limit 10000\nset -g mouse on\n' > /etc/opalix-tmux.conf


ARG GRAFANA_VERSION=11.4.0
# sha256 of the 11.4.0 amd64 .deb (matches the checksum Grafana publishes on
# its download page); bump it together with GRAFANA_VERSION. The same goes for
# every other download below: a version bump means a new sha256 next to it.
RUN curl -fsSL "https://dl.grafana.com/oss/release/grafana_${GRAFANA_VERSION}_amd64.deb" -o /tmp/grafana.deb \
    && echo "4cff89724f4a06f53fc1187c6c2011206084baf13da6d443c2fb14b4ba272bb0  /tmp/grafana.deb" | sha256sum -c - \
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
    && echo "19700bdd42ec31ee162e4079ebda4cd0a44432df4daa637141bdbea4b1cd8927  /tmp/prom.tgz" | sha256sum -c - \
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
    && echo "f5741318ea2c3a2e64a1e1fffafcd1b03872ed0783ec5e7675fb6c686bfc7a5a  /tmp/jaeger.tgz" | sha256sum -c - \
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
    && echo "778c689efa681ff6e4722ce9f66b9b7f57c3ba009ab2e2b43dc2e0315862c731  /tmp/otelcol.tgz" | sha256sum -c - \
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
# images/agent/Dockerfile (pinned 1.0.10 -- requirements-contextforge.txt,
# the full frozen dependency tree -- Python 3.12 from deadsnakes in
# its own venv since no version with the multi-tenancy features these
# labs need supports this image's own default Python either) -- see that
# file's own comments for the full reasoning, not repeated here.
#
# ContextForge's own start_jq_pool() forks a ProcessPoolExecutor at boot
# by default, which needs a POSIX semaphore backed by /dev/shm --
# confirmed live on the agent image (a bare FileNotFoundError from
# multiprocessing/synchronize.py's SemLock, well past the build-time
# import check below, surfacing at the app's actual startup as an
# unexplained port-timeout). Lab containers have no /dev/shm (the same
# gap the Postgres dynamic_shared_memory_type=sysv workaround exists for
# elsewhere in this image). `inprocess` mode skips the fork sandbox
# entirely -- an accepted trade here, since there's no real jq-filter
# security boundary to protect in a training environment, and not a
# decision any lab should have to make in every manifest.
ENV JQ_FILTER_EXECUTION=inprocess

# python3.12/python3.12-venv are pinned to the deadsnakes build that was
# running (3.12.14-1+jammy1). A PPA only indexes its current build, so once
# deadsnakes publishes a newer 3.12 for jammy this exact version disappears
# and the build fails loudly at the apt-get install: bump it on purpose then.
#
# The python3.12 shadowing below is a wrapper script, not a symlink --
# three real CI build failures on the agent image (27 Sep 2026) before
# landing on this. A /usr/local/bin-only symlink still raised
# ModuleNotFoundError (not a PATH-ordering issue as first assumed); a
# symlink overwriting /usr/bin/python3.12 too then failed with "Too many
# levels of symbolic links", because `python3.12 -m venv` makes the
# venv's own bin/python3.12 a symlink BACK to the system interpreter --
# so any plain symlink placed outside the venv's own bin/ directory
# either misses the venv's site-packages (CPython's pyvenv.cfg lookup
# keys off the literal invoked path, not the realpath) or, when it
# targets /usr/bin/python3.12, closes a symlink loop. A first wrapper-
# script attempt then HUNG a real CI build for its full job timeout with
# zero output: the venv's bin/python3.12 was still a symlink to
# /usr/bin/python3.12, so overwriting that path with the wrapper made the
# symlink resolve back to the wrapper itself, and its own `exec` line
# re-invoked it forever (`exec` replaces the process image, so this loops
# silently rather than crashing or growing a stack). Fixed by decoupling
# the venv's interpreter path from /usr/bin entirely first: a private
# real copy of the interpreter is made and the venv's own symlink is
# repointed at it, before /usr/bin/python3.12 is touched at all. Needed
# because a lab invoking `python3.12 -m mcpgateway` directly -- exactly
# what this lab does -- would otherwise fail the same way.
COPY requirements-contextforge.txt /tmp/req/
RUN apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    python3.12=3.12.14-1+jammy1 python3.12-venv=3.12.14-1+jammy1 \
    && rm -rf /var/lib/apt/lists/* \
    && python3.12 -m venv /opt/contextforge-venv \
    && /opt/contextforge-venv/bin/pip install --no-cache-dir -r /tmp/req/requirements-contextforge.txt \
    && /opt/contextforge-venv/bin/pip show mcp-contextforge-gateway | grep -qx 'Version: 1.0.10' \
    && ln -s /opt/contextforge-venv/bin/mcpgateway /usr/local/bin/mcpgateway \
    && ln -s /opt/contextforge-venv/bin/mcpgateway-server /usr/local/bin/mcpgateway-server \
    && cp -L /opt/contextforge-venv/bin/python3.12 /opt/contextforge-venv/python3.12-real \
    && ln -sf /opt/contextforge-venv/python3.12-real /opt/contextforge-venv/bin/python3.12 \
    && rm -f /usr/bin/python3.12 \
    && printf '#!/bin/sh\nexec /opt/contextforge-venv/bin/python3.12 "$@"\n' > /usr/local/bin/python3.12 \
    && chmod +x /usr/local/bin/python3.12 \
    && cp /usr/local/bin/python3.12 /usr/bin/python3.12 \
    && test -x /usr/local/bin/mcpgateway && test -x /usr/local/bin/mcpgateway-server \
    && python3.12 -c "import mcpgateway; print(mcpgateway.__version__)"

# --break-system-packages does not exist on this base image's pip3
# (22.0.2, from Ubuntu 22.04's python3-pip) -- that flag only exists on
# pip 23.0.1+ / newer Ubuntu releases that enforce PEP 668. Confirmed by a
# real CI build failure (23 Sep 2026, "no such option: --break-system-packages").
#
# Pinned to 1.102.1: the exact version "litellm[proxy]" resolved to and the
# one proven live in docs/spike.md. `litellm[proxy]` does NOT
# install the `prisma` Python package (confirmed live: right after this
# install, `pip3 show prisma` finds nothing, and starting the proxy against
# Postgres crashes with `ModuleNotFoundError: No module named 'prisma'`),
# so prisma==0.15.0 -- the version the build-time `prisma generate` step
# below matches -- is installed alongside it explicitly.
#
# requirements-system.txt is the full `pip3 freeze` of this shared
# environment as deployed: litellm[proxy]==1.102.1, prisma==0.15.0,
# locust==2.46.0, mlflow==3.16.1 and every other package below, with all
# their transitive dependencies. Because every version is fixed, the four
# install layers this section used to be (litellm+prisma+locust, then
# fastapi/uvicorn/psycopg, then flask/OTel, then the mlflow anchor) can no
# longer resolve differently depending on order: the first layer installs
# the whole set, the two middle layers only assert what they used to install,
# and the mlflow layer re-runs the same file as the resolver anchor it has
# always been (a no-op unless something has drifted). Packages owned by
# Ubuntu's apt (six, distro, oauthlib, dbus-python, python-apt, ...) are not in
# the file; the apt versions satisfy everything that needs them.
COPY requirements-system.txt /tmp/req/
RUN pip3 install --no-cache-dir -r /tmp/req/requirements-system.txt \
    && pip3 show litellm | grep -qx 'Version: 1.102.1'

# fastapi/uvicorn/psycopg2-binary, for Path 2 Module 3's pgvector labs: a
# live verification run caught two labs' own learner-facing services
# (labs/offer-a-retrieval-service-teams-dont-build's `platform`,
# labs/add-hybrid-search-and-reranking's `search`) invoking plain
# `python3`/`python3 -m uvicorn` directly, not an isolated venv -- neither
# was installed anywhere in this image. psycopg2-binary bundles its own
# libpq, so it needs nothing beyond the `postgresql` package already
# installed above.
#
# psycopg[binary] (v3) added separately: a later live run found
# add-hybrid-search-and-reranking's own workspace/search/db.py imports
# plain `psycopg`, not `psycopg2` -- a different package under the same
# name family, confirmed live with ModuleNotFoundError: No module named
# 'psycopg'. Its actual calls (connect/cursor/execute/fetchone, %s
# placeholders) are plain DB-API and would run identically under
# psycopg2, but that file is given lab infrastructure, not something to
# rewrite to match its siblings' choice -- installing the package it
# actually names is the smaller, more faithful fix.
#
# Already installed by requirements-system.txt above (fastapi==0.142.1,
# uvicorn[standard]==0.54.0, psycopg2-binary==2.9.13, psycopg[binary]==3.3.6);
# this layer only asserts it.
RUN python3 -c "import fastapi, uvicorn, psycopg2, psycopg"

# flask/requests + the OTel SDK and its Flask/requests auto-instrumentation,
# for Path 2 Module 4's tracing labs: a live verification run found three
# of that module's own services (labs/follow-one-request-through-the-stack's
# seed_trace.py, labs/see-one-request-across-every-service's gateway/worker/
# storage) invoke plain python3 directly against these packages, none of
# which existed anywhere in this image -- same shared-environment
# convention as fastapi/psycopg2 above, not an isolated venv.
#
# opentelemetry-instrumentation-fastapi/-httpx: a further live verification
# run (labs/prove-where-one-requests-data-went) found LiteLLM's own proxy
# process (workspace/gateway/run_instrumented_litellm.py) crashes at import
# with ModuleNotFoundError -- it instruments LiteLLM's real FastAPI app and
# its own outbound httpx client (the FastAPI/httpx equivalents of the
# Flask/requests instrumentation above, since LiteLLM's proxy is a FastAPI
# app whose provider calls go through httpx, not Flask/requests), and
# neither package existed in this image either.
#
# Already installed by requirements-system.txt above (flask==3.1.3,
# requests==2.34.2, opentelemetry-sdk==1.45.0, the 1.45.0 OTLP/HTTP exporter and
# the 0.66b0 flask/requests/fastapi/httpx instrumentation); this layer only
# asserts it.
RUN python3 -c "import flask, requests, opentelemetry.sdk.trace, opentelemetry.instrumentation.flask, opentelemetry.instrumentation.requests, opentelemetry.instrumentation.fastapi, opentelemetry.instrumentation.httpx"

# MLflow, for Path 2's model-catalogue lab: its model registry's aliases
# drive which provider model a LiteLLM alias points to. Pinned to 3.16.1,
# the version the feasibility run proved alongside litellm 1.102.1 and
# prisma 0.15.0 (`pip check` clean in one environment). The full package,
# not mlflow-skinny: skinny can't run `mlflow server` without a hand-picked
# set of extra deps and never ships the UI at all.
#
# litellm and prisma are named again at their pins so pip resolves MLflow
# around them instead of upgrading a dependency they were proven with.
#
# requirements-system.txt (mlflow==3.16.1, litellm[proxy]==1.102.1,
# prisma==0.15.0, all transitive pins) is run again here, deliberately: the
# same file as the first layer, which has already installed all of it, so this
# is the anchor kept in its original place and a no-op unless something drifted.
RUN pip3 install --no-cache-dir -r /tmp/req/requirements-system.txt \
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
# coverage).
#
# CORRECTION (live verification, 27 Sep 2026): the claim two lines above
# used to end "...so a placeholder file is enough" -- wrong, and it took a
# real session to find out. Phoenix's own
# phoenix/server/sandbox/_download.py validates the file at this path is
# non-empty before using it and raises a hard ValueError if it isn't,
# crashing the whole server at boot (diagnosed by temporarily redirecting
# the service's stdout to a world-readable log file, since the platform's
# own log-tail capture came back empty both on the original crash and on
# a stuck restart). An empty placeholder was never "enough" -- nothing
# ever exercised this path with PHOENIX_WORKING_DIR actually set (a
# Postgres-backed session, this lab's own shape) until now. Fixed by
# fetching the exact binary and pinned release Phoenix's own downloader
# would otherwise fetch at runtime, with the same SHA256 it already
# hardcodes for verification -- so this is the identical artifact, just
# pre-fetched at build time instead of on every boot.
# Paths -- /opt/opalix/venvs/phoenix and /opt/opalix/assets/phoenix-wasm/
# -- match what the Module 3 lab-building agents independently converged
# on and already shipped inside labs/see-why-a-document-matched/manifest.yaml
# (`argv: ["/opt/opalix/venvs/phoenix/bin/python", ...]`), rather than the
# other way around: a live verification run caught this image using
# /opt/phoenix-venv instead and failing with a plain ENOENT at session
# start, exactly the kind of image/lab integration mismatch live testing
# exists to catch. Conforming the image to the already-tested lab, not
# editing the lab to match a path nothing else depends on.
COPY requirements-phoenix.txt /tmp/req/
RUN python3 -m venv /opt/opalix/venvs/phoenix \
    && /opt/opalix/venvs/phoenix/bin/pip install --no-cache-dir -r /tmp/req/requirements-phoenix.txt \
    && /opt/opalix/venvs/phoenix/bin/pip show arize-phoenix | grep -qx 'Version: 20.16.0' \
    && ln -s /opt/opalix/venvs/phoenix/bin/phoenix /usr/local/bin/phoenix \
    && test -x /usr/local/bin/phoenix \
    && mkdir -p /opt/opalix/assets/phoenix-wasm \
    && curl -fsSL \
       "https://github.com/vmware-labs/webassembly-language-runtimes/releases/download/python%2F3.12.0%2B20231211-040d5a6/python-3.12.0.wasm" \
       -o /opt/opalix/assets/phoenix-wasm/pyodide.wasm \
    && echo "e5dc5a398b07b54ea8fdb503bf68fb583d533f10ec3f930963e02b9505f7a763  /opt/opalix/assets/phoenix-wasm/pyodide.wasm" | sha256sum -c -
ENV PHOENIX_TELEMETRY_ENABLED=false
ENV PHOENIX_DISABLE_AGENT_ASSISTANT=true
ENV PHOENIX_WASM_BINARY_PATH=/opt/opalix/assets/phoenix-wasm/pyodide.wasm

# labs/see-why-a-document-matched's own `app` service assumes its own
# isolated venv at this exact path (defensive, per its own manifest
# comment, against an unconfirmed conflict with the shared environment
# above -- never actually tested against this real image at build time).
# Same conform-the-image-to-the-tested-lab reasoning as Phoenix's path
# fix above.
COPY requirements-see-why.txt /tmp/req/
RUN python3 -m venv /opt/opalix/venvs/see-why-a-document-matched \
    && /opt/opalix/venvs/see-why-a-document-matched/bin/pip install --no-cache-dir -r /tmp/req/requirements-see-why.txt \
    && /opt/opalix/venvs/see-why-a-document-matched/bin/python -c "import fastapi, uvicorn, psycopg2, opentelemetry.sdk.trace, openinference.semconv.trace"

# Presidio + spaCy, for Module 7's labs/strip-personal-data-before-it-leaves.
# Its own isolated venv, not this image's shared pip environment --
# CONFIRMED, not just suspected: installing litellm[proxy]==1.102.1 and
# presidio-anonymizer==2.2.364 into the same venv produces a real pip
# dependency-resolver conflict --
#   presidio-anonymizer 2.2.364 requires cryptography<49.0.0,>=48.0.1,
#   but litellm[proxy] pulls in cryptography 50.0.1 (transitively, via its
#   own proxy extras) and pip's resolver silently keeps the newer,
#   out-of-range one installed instead of failing the install outright.
# That is exactly the kind of collision this image's shared environment
# already juggles between litellm and mlflow (see the MLflow block above)
# and a THIRD heavy, separately-pinned dependency tree is not worth adding
# to it, especially one (spaCy's own C-extension stack: numpy, thinc,
# blis, murmurhash, preshed, cymem) that risks an ABI mismatch rather than
# just a version-string mismatch if it silently shares a numpy with
# whatever litellm/mlflow already loaded into the same interpreter.
#
# hooks/pii_guard.py reaches this install with a small sys.path shim (see
# that file's own top-of-file comment) rather than needing this installed
# into litellm's own venv at all -- so this venv's site-packages only ever
# need to be *importable* from the litellm process, never *installed
# alongside* litellm's own dependencies. This is the same
# isolate-the-risky-dependency shape as ContextForge's own Python 3.12 venv
# in images/agent/Dockerfile and this image's own Phoenix block above, just
# without a wrapper binary, since nothing needs to invoke a `presidio` CLI
# the way `phoenix` or `mcpgateway` are invoked directly.
#
# en_core_web_sm and es_core_news_sm are pre-downloaded here, at build
# time, as exact-version wheels (3.8.0 each, the spaCy releases matching
# spacy==3.8.16) pinned in requirements-presidio.txt as `<name> @ <url>` from
# the explosion/spacy-models GitHub releases -- the URLs `spacy download`
# itself resolves to, minus its compatibility-table lookup that could pick a
# different model version. They are loaded once as a smoke test -- exactly like Phoenix's WASM
# binary and this project's other model/binary pre-fetches, because lab
# containers have no network at runtime (the egress fence) and a bare
# `AnalyzerEngine()` with no explicit model config would otherwise try to
# download spaCy's 400MB en_core_web_lg over the network on first use and
# fail outright. Both models are small (~15MB and ~16MB) -- confirmed live
# in this session's own feasibility investigation, along with confirming
# real PERSON/EMAIL_ADDRESS/PHONE_NUMBER/CREDIT_CARD/US_SSN detection in
# both English and Spanish text using exactly these two models, and
# confirming the whole pipeline needs no network at all once they're on
# disk (tested inside a real `unshare --net` namespace).
COPY requirements-presidio.txt /tmp/req/
RUN python3 -m venv /opt/opalix/venvs/presidio \
    && /opt/opalix/venvs/presidio/bin/pip install --no-cache-dir -r /tmp/req/requirements-presidio.txt \
    && /opt/opalix/venvs/presidio/bin/pip show spacy | grep -qx 'Version: 3.8.16' \
    && /opt/opalix/venvs/presidio/bin/pip show en_core_web_sm | grep -qx 'Version: 3.8.0' \
    && /opt/opalix/venvs/presidio/bin/pip show es_core_news_sm | grep -qx 'Version: 3.8.0' \
    && /opt/opalix/venvs/presidio/bin/python -c "\
import presidio_analyzer, presidio_anonymizer, spacy; \
spacy.load('en_core_web_sm'); \
spacy.load('es_core_news_sm'); \
print('presidio + both spacy models import and load cleanly')"

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
