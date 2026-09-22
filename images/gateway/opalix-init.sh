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

# Idle forever; services are started individually by the Session DO via
# exec(), not by this script, so a lab's manifest controls what runs and in
# what order (see src/session/services.ts).
exec sleep infinity
