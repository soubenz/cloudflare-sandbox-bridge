`opalix-init.sh` here is the canonical source. Docker's build context for
each family is that family's own directory (`images/agent/`,
`images/gateway/`) — `COPY` cannot reach outside it — so the file is
duplicated into each family folder rather than referenced with `../common/`.
If a third family is added, copy it there too. Keep the two copies
byte-identical; nothing currently enforces that automatically.
