#!/usr/bin/env bash
# CMD for every Opalix lab image. Runs as PID 1's child after the sandbox
# control server is already listening (see Dockerfile comment: never
# override ENTRYPOINT). Its only job at boot is to install the outbound-
# interception CA for anything in the image that speaks HTTPS to an
# allowlisted host; the container itself talks plain http:// to the LLM
# Worker and mirror host so this is a belt-and-braces step, not load-bearing.
set -euo pipefail

CA_SRC=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$CA_SRC" ]; then
  cp "$CA_SRC" /usr/local/share/ca-certificates/opalix-outbound-ca.crt
  update-ca-certificates || true
fi

# Python's httpx/requests trust certifi's bundled CA list, not the system
# store update-ca-certificates just updated, so CERTIFICATE_VERIFY_FAILED
# against an allowed HTTPS host is otherwise still live for them (curl and
# urllib are unaffected; confirmed in docs/spike.md). The image sets
# SSL_CERT_FILE/REQUESTS_CA_BUNDLE as ENV so a shell exec'd straight from
# the container's process manager gets them, but the learner's terminal is
# `su -l learner`, a login shell that drops the image's ENV entirely --
# so the same pair is written here for login shells to pick back up, the
# same way the platform delivers the rest of the lab env
# (/etc/profile.d/).
cat > /etc/profile.d/opalix-ssl.sh <<'EOF'
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
EOF

# Idle forever; services are started individually by the Session DO via
# exec(), not by this script, so a lab's manifest controls what runs and in
# what order (see src/session/services.ts).
exec sleep infinity
