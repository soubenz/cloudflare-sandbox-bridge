`opalix-init.sh` here is the canonical source. Docker's build context for
each family is that family's own directory (`images/agent/`,
`images/gateway/`) — `COPY` cannot reach outside it — so the file is
duplicated into each family folder rather than referenced with `../common/`.
If a third family is added, copy it there too. The two family copies must
stay byte-identical to this one, and CI enforces it twice:
`test/unit/init-script-copies.test.ts` (part of `npm test`) and the
`init.sh copies are identical` step in `.github/workflows/deploy.yml`, which
runs `cmp` before the Dry-run. Either fails the deploy if a copy differs.
Edit all three together.
