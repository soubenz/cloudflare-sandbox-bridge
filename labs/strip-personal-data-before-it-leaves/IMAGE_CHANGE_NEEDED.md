# Image change needed for labs/strip-personal-data-before-it-leaves

This lab's `gateway/hooks/pii_guard.py` needs `presidio-analyzer`,
`presidio-anonymizer` and `spacy` (plus two pre-downloaded spaCy models)
importable from inside the `litellm` process, with no network access at
session runtime. **I have not edited `images/gateway/Dockerfile`** --
that's shared infrastructure another process manages. This file describes
the exact change and why, for that process to review and apply.

## What to add, and why

Add a new isolated venv, in the same spot and the same shape as the
Phoenix and `see-why-a-document-matched` blocks already in this Dockerfile
(around line 419, right before the `prisma generate` step) -- own venv,
this image's own default `python3`, `pip install --no-cache-dir`, then a
hard `import` assertion so the build fails loudly instead of shipping an
image where the lab silently can't start:

```dockerfile
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
# time, and loaded once as a smoke test -- exactly like Phoenix's WASM
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
RUN python3 -m venv /opt/opalix/venvs/presidio \
    && /opt/opalix/venvs/presidio/bin/pip install --no-cache-dir \
       "presidio-analyzer==2.2.364" "presidio-anonymizer==2.2.364" "spacy==3.8.16" \
    && /opt/opalix/venvs/presidio/bin/python -m spacy download en_core_web_sm \
    && /opt/opalix/venvs/presidio/bin/python -m spacy download es_core_news_sm \
    && /opt/opalix/venvs/presidio/bin/python -c "\
import presidio_analyzer, presidio_anonymizer, spacy; \
spacy.load('en_core_web_sm'); \
spacy.load('es_core_news_sm'); \
print('presidio + both spacy models import and load cleanly')"
```

Nothing else in the image needs to change: no new apt packages, no new
`ENV`, no wrapper binary on `PATH` (unlike ContextForge/Phoenix, nothing
here needs to be invoked as a standalone CLI -- `hooks/pii_guard.py` only
ever imports it as a library, in-process).

## How the lab reaches this install without a shared-venv `pip install`

`workspace/gateway/hooks/pii_guard.py` (and
`solution/gateway/hooks/pii_guard.py`) each open with:

```python
import glob, os, sys
_PRESIDIO_VENV = "/opt/opalix/venvs/presidio"
for _site_packages in glob.glob(os.path.join(_PRESIDIO_VENV, "lib", "python3.*", "site-packages")):
    if _site_packages not in sys.path:
        sys.path.insert(0, _site_packages)
```

before `import presidio_analyzer` etc. This makes the isolated venv's
packages importable from inside whatever process LiteLLM itself runs in
(the same interpreter, since venvs share the base interpreter binary --
only `site-packages` is isolated), without ever `pip install`-ing anything
from it into litellm's own environment, and without a second process or
IPC hop. The glob avoids hard-coding a Python minor version.

**One residual risk I could not verify without the real image**: this
only avoids an ABI/version collision if nothing litellm imports *before*
this shim runs has already pulled `numpy`, `pydantic`, or another package
spaCy's C-extensions are sensitive to into `sys.modules` at an
incompatible version -- Python's import system prefers whatever's already
cached in `sys.modules` over `sys.path`, so a prior import from litellm's
own venv would silently win over this shim for any name already loaded.
I have no evidence this happens (litellm itself doesn't appear to depend
on `numpy` or `spacy`), but I also have no way to prove it doesn't inside
the real gateway image from this session. **Please boot the real image
with this change and confirm `hooks/pii_guard.py` imports and its analyzer
loads cleanly** (the exact smoke-test line the Dockerfile RUN above
already runs is the same check). If that ever does turn up a real
collision, the fallback is a small sidecar process launched from
`/opt/opalix/venvs/presidio/bin/python` that `pii_guard.py` talks to over
localhost HTTP instead of importing in-process -- full process isolation,
no shim, no shared-interpreter risk, at the cost of one more manifest
service and an HTTP round-trip per call. I did not build the lab that way
because the task explicitly named `hooks/pii_guard.py` (a direct
in-process hook, following `hard-budget-per-team`'s own hook-wiring shape)
as the file to ship, but the sidecar shape is a one-file, mechanical
change to `pii_guard.py` if this in-process approach doesn't pan out.

## What I verified locally instead (this session, no real gateway image)

I do not have the real `images/gateway` container in this environment. What
I verified in a throwaway venv on this machine, combined with real LiteLLM
1.102.1 + real Postgres:

- Presidio configured with only `en_core_web_sm` (the shipped skeleton's
  bug) redacts English PII correctly but misses a real Spanish name
  (`Alejandro Fernandez Ruiz`) entirely, while still catching
  language-agnostic regex entities (email, phone) in the same Spanish
  message -- this is exactly the shape of gap the lab is built around.
- Presidio configured with both `en_core_web_sm` and `es_core_news_sm`,
  analyzing every message under both languages, catches all of it.
- A message with no real PII survives untouched under both
  configurations.
- All of the above ran with `litellm[proxy]==1.102.1` and
  `presidio-analyzer`/`presidio-anonymizer`/`spacy` installed into the
  *same* venv (not isolated) -- acceptable for verifying the hook logic
  and the checks, per this task's own instructions, but this is
  specifically NOT a substitute for verifying the isolated-venv
  installation in the real image, which only the main session can do.

See this lab's own `checks/` output (reported alongside this file) for the
full verification transcript.
