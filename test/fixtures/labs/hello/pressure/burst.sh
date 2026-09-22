#!/usr/bin/env bash
# A no-op pressure script for the fixture lab — real labs would perturb the
# running system here (traffic burst, a second failure, etc).
echo "pressure event fired at $(date -u +%FT%TZ)" >> /tmp/opalix-pressure.log
