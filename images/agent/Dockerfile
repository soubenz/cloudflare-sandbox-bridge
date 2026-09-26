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
# Retried: the Ubuntu mirrors serve an index mid-sync often enough that a
# plain `apt-get update` fails the whole build with "File has unexpected
# size", and every deploy rebuilds these images.
RUN for attempt in 1 2 3; do \
      apt-get update -o Acquire::Retries=3 && break || { echo "apt-get update failed (attempt $attempt)"; sleep 10; }; \
    done \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    curl ca-certificates sudo musl tmux \
    && rm -rf /var/lib/apt/lists/*

# The learner's shell runs inside tmux so it survives the PTY connection
# dropping (a closed browser tab, a Durable Object eviction): the container's
# PTY server kills its shell when the websocket goes away, but tmux keeps
# the session, its cwd, its environment and any running process.
# Presented as a plain terminal — no status bar, and a deep scrollback.
RUN printf 'set -g status off\nset -g history-limit 10000\nset -g mouse on\n' > /etc/opalix-tmux.conf


# --- Grafana (OSS) ---
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

# --- LiteLLM proxy ---
# `python3 -m pip`, not bare `pip`: the base image's Python (the SDK's
# python-build-standalone interpreter) does not put a `pip` binary on PATH,
# confirmed by a real CI build failure (23 Sep 2026, "pip: not found").
RUN python3 -m pip install --no-cache-dir "litellm[proxy]"

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

# --- ContextForge (mcp-contextforge-gateway), for Path 2 Module 2's tool-gateway labs ---
# Pinned to 1.0.10: every lab in this module was proven against exactly this
# version, and its own quirks are load-bearing (see labs/*/manifest.yaml
# header comments for the associated_tools casing trap, the token scope
# shape, the deprecated-flag-is-inert bug, and the admin UI's login
# redirect and missing reverse-proxy support). No version of this package
# that has the multi-tenancy/virtual-server features these labs need
# supports this image's own default Python (3.11, from the base image's
# bundled interpreter -- confirmed live, docs/spike.md): 0.2.0 through
# 1.0.7 need 3.11, but 1.0.8+ (where the last of these labs' needed
# features landed) needs 3.12. Rather than re-pin to an older release and
# re-verify every already-proven quirk against it, this installs Python
# 3.12 from the deadsnakes PPA (Ubuntu 22.04/jammy is a supported distro
# for it) into its own venv, alongside the base image's own 3.11 default
# -- so litellm, matplotlib/numpy/pandas and everything else already
# installed against python3 stay on 3.11 untouched.
RUN apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    software-properties-common gnupg \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
    python3.12 python3.12-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3.12 -m venv /opt/contextforge-venv \
    && /opt/contextforge-venv/bin/pip install --no-cache-dir "mcp-contextforge-gateway==1.0.10" \
    && /opt/contextforge-venv/bin/pip show mcp-contextforge-gateway | grep -qx 'Version: 1.0.10'

# The package's two console-script entry points (mcpgateway, the CLI a lab's
# argv runs directly, and mcpgateway-server, the one some labs launch via a
# wrapper shell) live in the venv's own bin/ -- symlinked onto the system
# PATH so a lab's argv can name them directly, the same way `litellm` above
# resolves without a lab needing to know it's a pip console script either.
#
# The import check deliberately stops at the bare package, not
# `mcpgateway.main`/`mcpgateway.middleware.rbac` as first written: both of
# those (and in fact any access to `mcpgateway.config`'s lazy module
# `__getattr__`) construct a real pydantic Settings object on import, which
# 1.0.10 hardens against exactly this situation -- an unset JWT_SECRET_KEY /
# AUTH_ENCRYPTION_SECRET at build time -- by raising
# SecurityConfigurationError for the literal "__REPLACE_ME__" placeholder.
# Reproduced locally in a matching python3.12 venv: `import mcpgateway` alone
# never touches Settings and succeeds cleanly; `import mcpgateway.main`,
# `import mcpgateway.middleware.rbac`, and even a bare `importlib.util.find_spec`
# on either dotted path all fail the same way (find_spec still imports the
# parent packages). Setting one real secret isn't a fix either -- the
# validator checks several fields in turn (JWT_SECRET_KEY first, then
# AUTH_ENCRYPTION_SECRET), so satisfying it fully at build time means baking
# in placeholder "real" secrets that would then need rotating before the
# image is trusted for anything -- not worth it just to prove an import
# works. `pip show` above already confirms the exact pinned version
# installed; this adds only what that doesn't cover, that the package's
# top-level module is actually importable (catches missing/broken
# dependencies bytecode-compiled wrong, etc.) without constructing app config.
RUN ln -s /opt/contextforge-venv/bin/mcpgateway /usr/local/bin/mcpgateway \
    && ln -s /opt/contextforge-venv/bin/mcpgateway-server /usr/local/bin/mcpgateway-server \
    && test -x /usr/local/bin/mcpgateway && test -x /usr/local/bin/mcpgateway-server \
    && /opt/contextforge-venv/bin/python3.12 -c "import mcpgateway; print(mcpgateway.__version__)"

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
